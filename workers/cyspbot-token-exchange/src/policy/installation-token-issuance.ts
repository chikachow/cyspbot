import {
  createInstallationTokenForRepository,
  resolveInstallationForRepository,
} from "@cyspbot/github/app";
import { GitHubApiError, type GitHubApiDependencies } from "@cyspbot/github/http";
import type { AuthenticatedContext, VerifiedSubjectToken } from "../authentication.ts";
import type { InstallationAccessTokenRequest } from "../installation-token-request.ts";
import type { TokenExchangeApplication } from "../token-exchange-application.ts";
import { evaluateConfiguredTokenPolicy, type TokenPolicyDecision } from "./token-policy.ts";

export type InstallationTokenIssuanceResult =
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
  application: TokenExchangeApplication,
  authenticationContext: AuthenticatedContext,
  tokenRequest: InstallationAccessTokenRequest,
  dependencies: GitHubApiDependencies,
): Promise<InstallationTokenIssuanceResult> {
  const { subjectToken } = authenticationContext;
  let policyDecision: TokenPolicyDecision | undefined;
  let targetInstallationId: number | undefined;

  try {
    policyDecision = evaluateConfiguredTokenPolicy(
      {
        subjectToken,
        tokenRequest,
      },
      application.tokenPolicy,
    );

    if (policyDecision.decision !== "allow") {
      throw new TokenPolicyDeniedError(policyDecision);
    }

    const requestedResourceName = `${tokenRequest.resource.owner}/${tokenRequest.resource.repository}`;
    const targetInstallation = await resolveInstallationForRepository(
      application.githubApp,
      requestedResourceName,
      dependencies,
    );
    targetInstallationId = targetInstallation.id;
    const installationToken = await createInstallationTokenForRepository(
      application.githubApp,
      targetInstallation.id,
      requestedResourceName,
      tokenRequest.permissions,
      dependencies,
    );

    console.info({
      event: "installation_token_issuance_succeeded",
      expires_at: installationToken.expiresAt,
      subject_token: subjectTokenLogFields(authenticationContext),
      target_installation: {
        id: targetInstallation.id,
        repository: requestedResourceName,
      },
      token_policy: {
        matched: true,
        rule_id: policyDecision.matchedRule.id,
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
      subject_token: subjectTokenLogFields(authenticationContext),
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

function subjectTokenLogFields(
  authenticationContext: AuthenticatedContext,
): Record<string, unknown> {
  return {
    issuer: authenticationContext.subjectToken.issuer,
    resolved_key_id: authenticationContext.subjectToken.resolvedKeyId,
    sub: subjectTokenSubjectLogValue(authenticationContext.subjectToken),
    subject_token_type: authenticationContext.subjectToken.subjectTokenType,
  };
}

function subjectTokenSubjectLogValue(subjectToken: VerifiedSubjectToken): string | null {
  const subject = subjectToken.claims.sub;

  return typeof subject === "string" ? subject : null;
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
      rule_id: policyDecision.matchedRule.id,
    };
  }

  return {
    matched: false,
  };
}
