import type { Env } from "../env.ts";
import { loadIssuerRegistrationByIssuer } from "../oidc/issuer-registrations.ts";
import type {
  AuthenticatedContext,
  AuthenticatedPrincipal,
  VerifyOidcTokenResult,
} from "../oidc/principals.ts";

export interface AuthenticateRequestFailure {
  httpStatus: number;
  ok: false;
  responseHeaders?: HeadersInit;
}

export interface AuthenticateRequestSuccess {
  context: AuthenticatedContext;
  ok: true;
}

export type AuthenticateRequestResult = AuthenticateRequestFailure | AuthenticateRequestSuccess;

export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthenticateRequestResult> {
  const token = extractBearerToken(request.headers.get("authorization"));

  if (token === null) {
    return {
      httpStatus: 401,
      ok: false,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  const issuerHint = unverifiedIssuerHint(token);

  if (issuerHint === null) {
    logAuthFailure(request, "missing_issuer", null, null);

    return {
      httpStatus: 401,
      ok: false,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  let issuerRegistration;

  try {
    issuerRegistration = await loadIssuerRegistrationByIssuer(env, issuerHint);
  } catch (error) {
    console.error("OIDC issuer registration configuration error", {
      errorMessage: error instanceof Error ? error.message : String(error),
      issuerHint,
      path: new URL(request.url).pathname,
    });

    return {
      httpStatus: 500,
      ok: false,
    };
  }

  if (issuerRegistration === null) {
    logAuthFailure(request, "unknown_issuer", issuerHint, null);

    return {
      httpStatus: 401,
      ok: false,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  const verifierStub = env.OIDC_ISSUER_VERIFIER.getByName(issuerRegistration.issuer);
  const verification = (await verifierStub.verifyOidcToken(
    token,
    issuerRegistration.issuer,
  )) as VerifyOidcTokenResult;

  if (!verification.ok) {
    const httpStatus = verification.reason === "configuration_error" ? 500 : 401;

    logAuthFailure(request, verification.reason, issuerHint, issuerRegistration.issuer);

    return {
      httpStatus,
      ok: false,
      responseHeaders:
        httpStatus === 401
          ? {
              "www-authenticate": "Bearer",
            }
          : undefined,
    };
  }

  return {
    context: {
      issuerRegistration,
      principal: verification.principal,
      resolvedKeyId: verification.resolvedKeyId,
    },
    ok: true,
  };
}

export function githubActionsPrincipal(
  principal: AuthenticatedPrincipal,
): principal is Extract<AuthenticatedPrincipal, { type: "github-actions" }> {
  return principal.type === "github-actions";
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
    return null;
  }

  return token;
}

function unverifiedIssuerHint(token: string): string | null {
  const segments = token.split(".");

  if (segments.length < 2) {
    return null;
  }

  try {
    const payloadSegment = segments[1];

    if (payloadSegment === undefined) {
      return null;
    }

    const payload = JSON.parse(atob(base64UrlToBase64(payloadSegment))) as { iss?: unknown };

    return typeof payload.iss === "string" && payload.iss.length > 0 ? payload.iss : null;
  } catch {
    return null;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4 || 4)) % 4), "=");

  return padded.replaceAll("-", "+").replaceAll("_", "/");
}

function logAuthFailure(
  request: Request,
  reason: string,
  issuerHint: string | null,
  configuredIssuer: string | null,
): void {
  const url = new URL(request.url);

  console.warn("OIDC authentication failed", {
    configuredIssuer,
    issuerHint,
    path: url.pathname,
    rayId: request.headers.get("cf-ray"),
    reason,
    userAgent: request.headers.get("user-agent"),
  });
}
