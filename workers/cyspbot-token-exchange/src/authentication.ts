import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import { OidcTokenVerifier } from "@cyspbot/oidc/verifier";
import { decodeJwt } from "jose";

export const cyspbotOidcAudience = "cyspbot";

export interface AuthenticatedContext {
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
  expectedAudience: string,
  issuerAdapters: readonly OidcIssuerAdapter<GitHubActionsPrincipal>[],
  fetchJwks?: typeof fetch,
): Promise<AuthenticateRequestResult> {
  const trustedIssuer = trustedIssuerForSubjectToken(token, issuerAdapters);

  if (!trustedIssuer.ok) {
    logAuthFailure(request, trustedIssuer.reason);

    return {
      ok: false,
      reason: trustedIssuer.reason,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  const verified = await oidcVerifierForTrustedIssuer(trustedIssuer.issuer, fetchJwks).verify(
    token,
  );

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

  const principal = trustedIssuer.adapter.derivePrincipal(verified.token.claims);

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
    !hasMatchingAudience(verified.token.claims.aud, expectedAudience) ||
    !trustedIssuer.adapter.validateSubjectTokenBinding({
      claims: verified.token.claims,
      expectedAudience,
    })
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
      issuer: verified.token.issuer,
      principal,
      resolvedKeyId: verified.token.resolvedKeyId,
    },
    ok: true,
  };
}

const oidcVerifiers = new WeakMap<TrustedOidcIssuer, OidcTokenVerifier>();

function trustedIssuerForSubjectToken(
  token: string,
  issuerAdapters: readonly OidcIssuerAdapter<GitHubActionsPrincipal>[],
):
  | {
      adapter: OidcIssuerAdapter<GitHubActionsPrincipal>;
      issuer: TrustedOidcIssuer;
      ok: true;
    }
  | { ok: false; reason: AuthenticateRequestFailureReason } {
  const issuer = unverifiedIssuer(token);

  if (issuer === null) {
    return { ok: false, reason: "invalid_token" };
  }

  for (const adapter of issuerAdapters) {
    const resolution = adapter.resolveIssuer(issuer);

    if (resolution.status === "unavailable") {
      return { ok: false, reason: "oidc_verifier_failure" };
    }

    if (resolution.status === "unhandled") {
      continue;
    }

    return { adapter, issuer: resolution.trustedIssuer, ok: true };
  }

  return { ok: false, reason: "invalid_token" };
}

function oidcVerifierForTrustedIssuer(
  issuer: TrustedOidcIssuer,
  fetchJwks: typeof fetch | undefined,
): OidcTokenVerifier {
  if (fetchJwks !== undefined) {
    return new OidcTokenVerifier({ fetchJwks, issuer });
  }

  const cachedVerifier = oidcVerifiers.get(issuer);

  if (cachedVerifier !== undefined) {
    return cachedVerifier;
  }

  const verifier = new OidcTokenVerifier({ issuer });
  oidcVerifiers.set(issuer, verifier);

  return verifier;
}

function unverifiedIssuer(token: string): string | null {
  try {
    const issuer = decodeJwt(token).iss;

    return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
  } catch {
    return null;
  }
}

function hasMatchingAudience(audienceClaim: unknown, expectedAudience: string): boolean {
  return typeof audienceClaim === "string" && audienceClaim === expectedAudience;
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
