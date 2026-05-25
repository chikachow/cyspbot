import type { Env } from "../env.ts";
import {
  createInstallationToken,
  GitHubApiError,
  resolveInstallationForRepository,
} from "../github/api.ts";
import type { AuthenticatedContext } from "../oidc/principals.ts";
import {
  authorizeInstallationTokenIssuance,
  TokenPolicyDeniedError,
} from "../policy/installation-token-issuance.ts";
import {
  createAuditIntent,
  finalizeAuditEntry,
  markAuditFinalizationFailed,
} from "../storage/d1.ts";
import { githubActionsPrincipal } from "./authentication.ts";
import type { AppDependencies } from "./dependencies.ts";
import { jsonResponse, problemResponse } from "./problem-details.ts";

const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const githubInstallationAccessTokenType = "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";
const oauthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token";

export async function handleClaimsRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const authentication = await dependencies.authenticateRequest(request, env);

  if (!authentication.ok) {
    return problemResponse(authentication.httpStatus, authentication.responseHeaders);
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return problemResponse(403);
  }

  try {
    await resolveInstallationForRepository(
      env,
      authentication.context.principal.repository,
      dependencies,
    );
  } catch (error) {
    return responseForGitHubApiError(error);
  }

  return jsonResponse({
    event_name: authentication.context.principal.eventName,
    ref: authentication.context.principal.ref,
    repository: authentication.context.principal.repository,
    repository_id: authentication.context.principal.repositoryId,
  });
}

export function tokenExchangeMethodNotAllowedResponse(): Response {
  return oauthErrorResponse(400, "invalid_request");
}

export async function handleTokenExchangeRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const grantType = singleFormValue(form, "grant_type");
  const requestedTokenType = singleFormValue(form, "requested_token_type");
  const subjectToken = singleFormValue(form, "subject_token");
  const subjectTokenType = singleFormValue(form, "subject_token_type");

  if (grantType !== tokenExchangeGrantType) {
    return oauthErrorResponse(400, "unsupported_grant_type");
  }

  if (subjectToken === null || subjectToken.length === 0 || subjectTokenType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (subjectTokenType !== oidcIdTokenType && subjectTokenType !== jwtTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (
    requestedTokenType !== null &&
    requestedTokenType !== githubInstallationAccessTokenType &&
    requestedTokenType !== oauthAccessTokenType
  ) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const authentication = await dependencies.authenticateOidcToken(subjectToken, request, env);

  if (!authentication.ok) {
    return oauthErrorResponse(
      authentication.httpStatus === 500 ? 500 : 400,
      authentication.httpStatus === 500 ? "server_error" : "invalid_request",
    );
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const result = await issueInstallationTokenForContext(env, authentication.context, dependencies);

  if (!result.ok) {
    return oauthErrorResponse(
      oauthStatusForIssuanceFailure(result.status),
      oauthErrorCodeForIssuanceFailure(result.status),
    );
  }

  return oauthTokenResponse({
    access_token: result.token,
    expires_in: expiresInSeconds(result.expiresAt, dependencies.now()),
    issued_token_type: githubInstallationAccessTokenType,
    token_type: "Bearer",
  });
}

interface InstallationTokenIssuanceSuccess {
  expiresAt: string;
  ok: true;
  token: string;
}

type InstallationTokenIssuanceResult =
  | InstallationTokenIssuanceSuccess
  | { ok: false; status: number };

async function issueInstallationTokenForContext(
  env: Env,
  authenticationContext: AuthenticatedContext,
  dependencies: AppDependencies,
): Promise<InstallationTokenIssuanceResult> {
  const { issuerRegistration, principal, resolvedKeyId } = authenticationContext;
  const requestedAt = dependencies.now().toISOString();
  let auditIntent;
  let installationId: number | undefined;

  try {
    auditIntent = await createAuditIntent(
      env,
      principal,
      issuerRegistration.issuer,
      resolvedKeyId,
      requestedAt,
    );
  } catch (error) {
    console.error("Installation Token Issuance audit intent write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      eventName: principal.eventName,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    return { ok: false, status: 500 };
  }

  try {
    const installation = await resolveInstallationForRepository(
      env,
      principal.repository,
      dependencies,
    );
    installationId = installation.id;

    const authorization = await authorizeInstallationTokenIssuance(
      env,
      installation.id,
      principal,
      dependencies,
    );
    const token = await createInstallationToken(
      env,
      installation.id,
      principal.repositoryId,
      authorization.policyDecision.permissions,
      dependencies,
    );

    await finalizeAuditEntry(env, {
      auditEntryId: auditIntent.id,
      expiresAt: token.expiresAt,
      finalizedAt: dependencies.now().toISOString(),
      installationId: installation.id,
      outcome: "issued",
      permissions: token.permissions,
    });

    return {
      expiresAt: token.expiresAt,
      ok: true,
      token: token.token,
    };
  } catch (error) {
    const status = statusForInstallationTokenIssuanceError(error);
    const outcome = outcomeForInstallationTokenIssuanceError(error);
    const reasons = reasonsForInstallationTokenIssuanceError(error);

    console.error("Installation Token Issuance failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      errorStatus: error instanceof GitHubApiError ? error.status : undefined,
      eventName: principal.eventName,
      installationId,
      outcome,
      ref: principal.ref,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    try {
      await finalizeAuditEntry(env, {
        auditEntryId: auditIntent.id,
        finalizedAt: dependencies.now().toISOString(),
        installationId,
        outcome,
        reasons,
      });
    } catch (finalizationError) {
      console.error("Installation Token Issuance audit finalization failed", {
        auditEntryId: auditIntent.id,
        errorMessage:
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
      });

      try {
        await markAuditFinalizationFailed(env, auditIntent.id, dependencies.now().toISOString());
      } catch {
        // The pending audit intent remains the durable gap record.
      }

      return { ok: false, status: 500 };
    }

    return { ok: false, status };
  }
}

function responseForGitHubApiError(error: unknown): Response {
  return problemResponse(statusForGitHubApiError(error));
}

function statusForGitHubApiError(error: unknown): number {
  if (error instanceof Response) {
    return error.status;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 400) {
      return 500;
    }

    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return 403;
    }

    if (error.status >= 500) {
      return 502;
    }
  }

  return 500;
}

function statusForInstallationTokenIssuanceError(error: unknown): number {
  if (error instanceof TokenPolicyDeniedError) {
    return 403;
  }

  return statusForGitHubApiError(error);
}

function outcomeForInstallationTokenIssuanceError(
  error: unknown,
): "denied" | "internal_error" | "upstream_error" {
  if (error instanceof TokenPolicyDeniedError) {
    return "denied";
  }

  if (error instanceof GitHubApiError) {
    return error.status >= 500 ? "upstream_error" : "denied";
  }

  return "internal_error";
}

function reasonsForInstallationTokenIssuanceError(error: unknown): string[] {
  if (error instanceof TokenPolicyDeniedError) {
    return error.policyDecision?.reasons.map(mapPolicyReason) ?? [];
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 404) {
      return ["github_installation_not_found"];
    }

    if (error.status === 429) {
      return ["github_upstream_rate_limited"];
    }

    if (error.status >= 500) {
      return ["github_upstream_unavailable"];
    }

    return ["github_upstream_unexpected_response"];
  }

  return ["internal_unexpected_error"];
}

function mapPolicyReason(reason: string): string {
  const mapped: Record<string, string> = {
    event_not_allowed: "policy_event_denied",
    ref_mismatch: "policy_ref_denied",
    ref_type_mismatch: "policy_ref_type_denied",
    repository_id_mismatch: "policy_repository_id_mismatch",
    repository_mismatch: "policy_repository_name_mismatch",
    repository_owner_id_mismatch: "policy_repository_owner_id_mismatch",
    repository_visibility_mismatch: "policy_repository_visibility_mismatch",
    subject_context_kind_mismatch: "policy_subject_mismatch",
    subject_context_not_allowed: "policy_subject_mismatch",
    subject_context_value_mismatch: "policy_subject_mismatch",
    subject_repository_mismatch: "policy_subject_mismatch",
  };

  return mapped[reason] ?? "internal_unexpected_error";
}

function isFormUrlEncodedContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function singleFormValue(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);

  if (values.length !== 1) {
    return null;
  }

  return values[0] ?? null;
}

function oauthTokenResponse(body: Record<string, number | string>): Response {
  return jsonResponse(body, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
    status: 200,
  });
}

function oauthErrorResponse(status: number, error: string): Response {
  return jsonResponse(
    { error },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      status,
    },
  );
}

function oauthErrorCodeForIssuanceFailure(status: number): string {
  if (status === 403) {
    return "invalid_target";
  }

  return "server_error";
}

function oauthStatusForIssuanceFailure(status: number): number {
  if (status === 403) {
    return 400;
  }

  if (status === 502) {
    return 502;
  }

  return 500;
}

function expiresInSeconds(expiresAt: string, now: Date): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
}
