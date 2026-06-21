import {
  createInstallationTokenForRepository,
  resolveInstallationForRepository,
} from "@cyspbot/github/app";
import { GitHubApiError, type GitHubApiDependencies } from "@cyspbot/github/http";
import type { AuthenticatedContext } from "../authentication.ts";
import {
  evaluateConfiguredTokenPolicy,
  parseGitHubRepositoryResource,
  type InstallationAccessTokenRequest,
  type TokenPolicyDecision,
  type TokenPolicyRule,
} from "./token-policy.ts";
import { tokenPolicyRules as defaultTokenPolicyRules } from "./token-policy-rules.ts";

export interface InstallationTokenIssuanceDependencies extends GitHubApiDependencies {
  tokenPolicyRules?: readonly TokenPolicyRule[];
}

type InstallationTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; status: number };

class TokenPolicyDeniedError extends Error {
  public readonly policyDecision: TokenPolicyDecision;

  public constructor(policyDecision: TokenPolicyDecision) {
    super("Token Policy denied Installation Token Issuance");
    this.policyDecision = policyDecision;
  }
}

export async function issueInstallationTokenForContext(
  env: TokenExchangeBindings,
  authenticationContext: AuthenticatedContext,
  tokenRequest: InstallationAccessTokenRequest,
  dependencies: InstallationTokenIssuanceDependencies,
): Promise<InstallationTokenIssuanceResult> {
  const { principal } = authenticationContext;
  let policyDecision: TokenPolicyDecision | undefined;
  let targetInstallationId: number | undefined;

  try {
    policyDecision = evaluateConfiguredTokenPolicy(
      {
        principal,
        tokenRequest,
      },
      dependencies.tokenPolicyRules ?? defaultTokenPolicyRules,
    );

    if (policyDecision.decision !== "allow") {
      throw new TokenPolicyDeniedError(policyDecision);
    }

    const requestedResource = parseGitHubRepositoryResource(tokenRequest.resource.href);

    if (requestedResource === null) {
      throw new GitHubApiError(400, "invalid token request resource");
    }

    const requestedResourceName = `${requestedResource.owner}/${requestedResource.repository}`;
    const targetInstallation = await resolveInstallationForRepository(
      env,
      requestedResourceName,
      dependencies,
    );
    targetInstallationId = targetInstallation.id;
    const installationToken = await createInstallationTokenForRepository(
      env,
      targetInstallation.id,
      requestedResourceName,
      tokenRequest.permissions,
      dependencies,
    );

    console.info({
      event: "installation_token_issuance_succeeded",
      expires_at: installationToken.expiresAt,
      principal: principalLogFields(authenticationContext),
      target_installation: {
        id: targetInstallation.id,
        repository: requestedResourceName,
      },
      token_policy: {
        matched: true,
        rule: policyDecision.matchedRule,
      },
      token_request: tokenRequestLogFields(tokenRequest),
    });

    return {
      expiresAt: installationToken.expiresAt,
      ok: true,
      token: installationToken.token,
    };
  } catch (error) {
    const status = statusForInstallationTokenIssuanceError(error);

    console.error({
      error: {
        message: logMessageForInstallationTokenIssuanceError(error),
        name: error instanceof Error ? error.name : typeof error,
        status: error instanceof GitHubApiError ? error.status : undefined,
      },
      event: "installation_token_issuance_failed",
      principal: principalLogFields(authenticationContext),
      target_installation: {
        id: targetInstallationId,
      },
      token_policy: tokenPolicyLogFields(error, policyDecision),
      token_request: tokenRequestLogFields(tokenRequest),
    });

    return { ok: false, status };
  }
}

function statusForInstallationTokenIssuanceError(error: unknown): number {
  if (error instanceof TokenPolicyDeniedError) {
    return 403;
  }

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

function logMessageForInstallationTokenIssuanceError(error: unknown): string {
  if (error instanceof GitHubApiError || error instanceof TokenPolicyDeniedError) {
    return error.message;
  }

  return "unexpected Installation Token Issuance error";
}

function principalLogFields(authenticationContext: AuthenticatedContext): Record<string, unknown> {
  const { principal } = authenticationContext;

  return {
    actor: principal.actor,
    event_name: principal.eventName,
    issuer: authenticationContext.issuer,
    ref: principal.ref,
    ref_type: principal.refType,
    repository: principal.repository,
    repository_id: principal.repositoryId,
    repository_owner_id: principal.repositoryOwnerId,
    repository_visibility: principal.repositoryVisibility,
    resolved_key_id: authenticationContext.resolvedKeyId,
    run_attempt: principal.runAttempt,
    run_id: principal.runId,
    sha: principal.sha,
    sub: principal.rawSubject,
    subject_kind: principal.subject.kind,
    workflow: principal.workflow,
    workflow_ref: principal.workflowRef,
  };
}

function tokenRequestLogFields(
  tokenRequest: InstallationAccessTokenRequest,
): Record<string, unknown> {
  return {
    permissions: tokenRequest.permissions,
    resource: tokenRequest.resource.href,
    scope: tokenRequest.scope,
  };
}

function tokenPolicyLogFields(
  error: unknown,
  policyDecision: TokenPolicyDecision | undefined,
): Record<string, unknown> {
  if (error instanceof TokenPolicyDeniedError) {
    return {
      deny_reasons:
        error.policyDecision.decision === "deny" ? error.policyDecision.reasons : undefined,
      matched: false,
    };
  }

  if (policyDecision?.decision === "allow") {
    return {
      matched: true,
      rule: policyDecision.matchedRule,
    };
  }

  return {
    matched: false,
  };
}
