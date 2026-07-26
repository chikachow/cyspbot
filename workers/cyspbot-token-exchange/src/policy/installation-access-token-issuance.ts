import {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} from "@cyspbot/github/app";
import { GitHubApiError, type GitHubApiDependencies } from "@cyspbot/github/http";
import type { AuthenticatedContext } from "../authentication.ts";
import type { InstallationAccessTokenRequest } from "../installation-access-token-request.ts";
import type { TokenExchangeApplication } from "../token-exchange-application.ts";
import { evaluateConfiguredTokenPolicy, type TokenPolicyDecision } from "./token-policy.ts";

export type InstallationAccessTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; status: number };

class TokenPolicyDeniedError extends Error {
  public readonly policyDecision: TokenPolicyDecision;

  public constructor(policyDecision: TokenPolicyDecision) {
    super("Token Policy denied Installation Access Token Issuance");
    this.policyDecision = policyDecision;
  }
}

export async function issueInstallationAccessTokenForContext(
  application: TokenExchangeApplication,
  authenticationContext: AuthenticatedContext,
  installationAccessTokenRequest: InstallationAccessTokenRequest,
  dependencies: GitHubApiDependencies,
): Promise<InstallationAccessTokenIssuanceResult> {
  const { verifiedSubjectToken } = authenticationContext;
  let policyDecision: TokenPolicyDecision | undefined;
  let targetInstallationId: number | undefined;

  try {
    policyDecision = evaluateConfiguredTokenPolicy(
      {
        verifiedSubjectToken,
        tokenRequest: installationAccessTokenRequest,
      },
      application.tokenPolicy,
    );

    if (policyDecision.decision !== "allow") {
      throw new TokenPolicyDeniedError(policyDecision);
    }

    const requestedResourceName = `${installationAccessTokenRequest.resource.owner}/${installationAccessTokenRequest.resource.repository}`;
    const targetInstallation = await resolveInstallationForRepository(
      application.githubApp,
      requestedResourceName,
      dependencies,
    );
    targetInstallationId = targetInstallation.id;
    const installationAccessToken = await createInstallationAccessTokenForRepositoryName(
      application.githubApp,
      targetInstallation.id,
      installationAccessTokenRequest.resource.repository,
      installationAccessTokenRequest.permissions,
      dependencies,
    );

    console.info({
      event: "installation_access_token_issuance_succeeded",
      expires_at: installationAccessToken.expiresAt,
      installation_access_token_request: installationAccessTokenRequestLogFields(
        installationAccessTokenRequest,
      ),
      subject_token: subjectTokenLogFields(authenticationContext),
      target_installation: {
        id: targetInstallation.id,
        repository: requestedResourceName,
      },
      token_policy: {
        matched: true,
        rule_id: policyDecision.matchedRule.id,
      },
    });

    return {
      expiresAt: installationAccessToken.expiresAt,
      ok: true,
      token: installationAccessToken.token,
    };
  } catch (error) {
    const status = statusForInstallationAccessTokenIssuanceError(error);

    console.error({
      error: {
        message: logMessageForInstallationAccessTokenIssuanceError(error),
        name: error instanceof Error ? error.name : typeof error,
        status: error instanceof GitHubApiError ? error.status : undefined,
      },
      event: "installation_access_token_issuance_failed",
      installation_access_token_request: installationAccessTokenRequestLogFields(
        installationAccessTokenRequest,
      ),
      subject_token: subjectTokenLogFields(authenticationContext),
      target_installation: {
        id: targetInstallationId,
      },
      token_policy: tokenPolicyLogFields(error, policyDecision),
    });

    return { ok: false, status };
  }
}

function statusForInstallationAccessTokenIssuanceError(error: unknown): number {
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

function logMessageForInstallationAccessTokenIssuanceError(error: unknown): string {
  if (error instanceof GitHubApiError || error instanceof TokenPolicyDeniedError) {
    return error.message;
  }

  return "unexpected Installation Access Token Issuance error";
}

function subjectTokenLogFields(
  authenticationContext: AuthenticatedContext,
): Record<string, unknown> {
  return {
    issuer: authenticationContext.verifiedSubjectToken.issuer,
    resolved_key_id: authenticationContext.verificationEvidence.resolvedKeyId,
    sub: authenticationContext.verifiedSubjectToken.claims.sub,
    subject_token_type: "id_token",
  };
}

function installationAccessTokenRequestLogFields(
  installationAccessTokenRequest: InstallationAccessTokenRequest,
): Record<string, unknown> {
  return {
    permissions: installationAccessTokenRequest.permissions,
    resource: installationAccessTokenRequest.resource.href,
    scope: installationAccessTokenRequest.scope,
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
