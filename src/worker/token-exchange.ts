import type { Env } from "../env.ts";
import { GitHubApiError, resolveInstallationForRepository } from "../github/api.ts";
import { jsonResponse, problemResponse } from "../http/problem-details.ts";
import { issueInstallationTokenForContext } from "../policy/installation-token-issuance.ts";
import { githubActionsPrincipal } from "./authentication.ts";
import type { AppDependencies } from "./dependencies.ts";

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
