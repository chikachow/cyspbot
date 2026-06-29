import {
  deriveGitHubActionsPrincipal,
  parseGitHubActionsClaims,
} from "@cyspbot/github-actions-oidc/github-actions-principal";
import { githubActionsTrustedIssuer } from "@cyspbot/github-actions-oidc/issuer";
import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { OidcTokenVerifier } from "@cyspbot/oidc/verifier";
import type { ParsedGitHubAppAudience } from "./policy/github-app-audience.ts";

export interface AuthenticatedContext {
  githubAppAudience: string;
  githubAppSlug: string;
  issuer: string;
  principal: GitHubActionsPrincipal;
  resolvedKeyId: string | null;
}

type AuthenticateRequestFailureReason =
  | "invalid_token"
  | "oidc_provider_failure"
  | "oidc_verifier_failure";

interface AuthenticateRequestFailure {
  errorCode?: string;
  ok: false;
  providerStatus?: number;
  reason: AuthenticateRequestFailureReason;
  responseHeaders?: HeadersInit;
}

interface AuthenticateRequestSuccess {
  context: AuthenticatedContext;
  ok: true;
}

export type AuthenticateRequestResult = AuthenticateRequestFailure | AuthenticateRequestSuccess;

export async function authenticateOidcToken(
  token: string,
  request: Request,
  expectedAudience: ParsedGitHubAppAudience,
  verifier: OidcTokenVerifier = githubActionsOidcVerifier,
): Promise<AuthenticateRequestResult> {
  const verified = await verifier.verify(token);

  if (!verified.ok) {
    const reason = authenticationFailureReasonForVerifierFailure(verified.reason);
    logAuthFailure(request, reason, {
      ...(verified.errorCode === undefined ? {} : { errorCode: verified.errorCode }),
      ...(verified.providerStatus === undefined ? {} : { providerStatus: verified.providerStatus }),
    });

    return {
      ...(verified.errorCode === undefined ? {} : { errorCode: verified.errorCode }),
      ok: false,
      ...(verified.providerStatus === undefined ? {} : { providerStatus: verified.providerStatus }),
      reason,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  const claims = parseGitHubActionsClaims(verified.token.claims);
  const principal = claims === null ? null : deriveGitHubActionsPrincipal(claims);

  if (principal === null) {
    logAuthFailure(request, "invalid_token");

    return {
      ok: false,
      reason: "invalid_token",
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  if (
    !hasMatchingAudience(verified.token.claims.aud, expectedAudience.audience) ||
    !hasMatchingAuthorizedParty(verified.token.claims["azp"], expectedAudience.audience)
  ) {
    logAuthFailure(request, "invalid_token");

    return {
      ok: false,
      reason: "invalid_token",
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  return {
    context: {
      githubAppAudience: expectedAudience.audience,
      githubAppSlug: expectedAudience.slug,
      issuer: verified.token.issuer,
      principal,
      resolvedKeyId: verified.token.resolvedKeyId,
    },
    ok: true,
  };
}

const githubActionsOidcVerifier = new OidcTokenVerifier({
  issuer: githubActionsTrustedIssuer,
});

function hasMatchingAudience(audienceClaim: unknown, expectedAudience: string): boolean {
  return typeof audienceClaim === "string" && audienceClaim === expectedAudience;
}

function hasMatchingAuthorizedParty(authorizedParty: unknown, audience: string): boolean {
  return authorizedParty === undefined || authorizedParty === audience;
}

function logAuthFailure(
  request: Request,
  reason: AuthenticateRequestFailureReason,
  diagnostics: { errorCode?: string; providerStatus?: number } = {},
): void {
  const url = new URL(request.url);

  console.warn("OIDC authentication failed", {
    path: url.pathname,
    rayId: request.headers.get("cf-ray"),
    reason,
    ...(diagnostics.errorCode === undefined ? {} : { errorCode: diagnostics.errorCode }),
    ...(diagnostics.providerStatus === undefined
      ? {}
      : { providerStatus: diagnostics.providerStatus }),
    userAgent: request.headers.get("user-agent"),
  });
}

function authenticationFailureReasonForVerifierFailure(
  reason: "invalid_token" | "provider_failure" | "verifier_failure",
): AuthenticateRequestFailureReason {
  if (reason === "provider_failure") {
    return "oidc_provider_failure";
  }

  if (reason === "verifier_failure") {
    return "oidc_verifier_failure";
  }

  return "invalid_token";
}
