import {
  deriveGitHubActionsPrincipal,
  parseGitHubActionsClaims,
} from "@cyspbot/github-actions-oidc/github-actions-principal";
import { githubActionsTrustedIssuer } from "@cyspbot/github-actions-oidc/issuer";
import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { OidcTokenVerifier } from "@cyspbot/oidc/verifier";

export interface AuthenticatedContext {
  issuer: string;
  principal: GitHubActionsPrincipal;
  resolvedKeyId: string | null;
}

interface AuthenticateRequestFailure {
  httpStatus: number;
  ok: false;
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
  verifier: OidcTokenVerifier = githubActionsOidcVerifier,
): Promise<AuthenticateRequestResult> {
  const verified = await verifier.verify(token);
  const claims = verified === null ? null : parseGitHubActionsClaims(verified.claims);
  const principal = claims === null ? null : deriveGitHubActionsPrincipal(claims);

  if (verified === null || principal === null) {
    logAuthFailure(request);

    return {
      httpStatus: 401,
      ok: false,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  return {
    context: {
      issuer: verified.issuer,
      principal,
      resolvedKeyId: verified.resolvedKeyId,
    },
    ok: true,
  };
}

const githubActionsOidcVerifier = new OidcTokenVerifier({
  issuer: githubActionsTrustedIssuer,
});

function logAuthFailure(request: Request): void {
  const url = new URL(request.url);

  console.warn("OIDC authentication failed", {
    path: url.pathname,
    rayId: request.headers.get("cf-ray"),
    reason: "invalid_token",
    userAgent: request.headers.get("user-agent"),
  });
}
