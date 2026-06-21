import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface TrustedOidcIssuer {
  allowedSigningAlgorithms: readonly string[];
  audience: string;
  issuer: string;
  jwksUri: URL;
  trustedAdditionalAudiences?: readonly string[];
}

export interface VerifiedOidcToken {
  claims: JWTPayload;
  issuer: string;
  resolvedKeyId: string | null;
}

type OidcTokenVerifierFailureReason = "invalid_token" | "provider_failure" | "verifier_failure";

interface OidcTokenVerifierFailure {
  errorCode?: string;
  ok: false;
  providerStatus?: number;
  reason: OidcTokenVerifierFailureReason;
}

interface OidcTokenVerifierSuccess {
  ok: true;
  token: VerifiedOidcToken;
}

export type OidcTokenVerifierResult = OidcTokenVerifierFailure | OidcTokenVerifierSuccess;

export interface OidcTokenVerifierOptions {
  fetchJwks?: typeof fetch;
  issuer: TrustedOidcIssuer;
}

export class OidcTokenVerifier {
  readonly #issuer: TrustedOidcIssuer;
  readonly #remoteJwks: JWTVerifyGetKey;

  public constructor(options: OidcTokenVerifierOptions) {
    this.#issuer = options.issuer;
    this.#remoteJwks = remoteJwks(options.issuer.jwksUri, options.fetchJwks);
  }

  public async verify(token: string): Promise<OidcTokenVerifierResult> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#remoteJwks, {
        algorithms: [...this.#issuer.allowedSigningAlgorithms],
        audience: this.#issuer.audience,
        issuer: this.#issuer.issuer,
      });

      if (!hasTrustedAudience(payload.aud, this.#issuer)) {
        return invalidTokenFailure();
      }

      if (!hasTrustedAuthorizedParty(payload["azp"], this.#issuer.audience)) {
        return invalidTokenFailure();
      }

      return {
        ok: true,
        token: {
          claims: payload,
          issuer: this.#issuer.issuer,
          resolvedKeyId: typeof protectedHeader.kid === "string" ? protectedHeader.kid : null,
        },
      };
    } catch (error) {
      return classifyVerificationError(error);
    }
  }
}

function hasTrustedAudience(audience: JWTPayload["aud"], issuer: TrustedOidcIssuer): boolean {
  if (typeof audience === "string") {
    return audience === issuer.audience;
  }

  if (!Array.isArray(audience) || !audience.includes(issuer.audience)) {
    return false;
  }

  const trustedAudiences = new Set([issuer.audience, ...(issuer.trustedAdditionalAudiences ?? [])]);

  return audience.every((entry) => trustedAudiences.has(entry));
}

function hasTrustedAuthorizedParty(authorizedParty: JWTPayload["azp"], audience: string): boolean {
  return authorizedParty === undefined || authorizedParty === audience;
}

function remoteJwks(jwksUri: URL, fetchJwks: typeof fetch | undefined): JWTVerifyGetKey {
  const fetchImplementation = fetchJwks ?? fetch;

  return createRemoteJWKSet(jwksUri, {
    [customFetch]: ((url, options) =>
      fetchRemoteJwks(fetchImplementation, url, options)) satisfies FetchImplementation,
  });
}

class OidcProviderJwksError extends Error {
  public readonly code: string;
  public readonly providerStatus: number | undefined;

  public constructor(code: string, options: { cause?: unknown; providerStatus?: number } = {}) {
    super(
      "OIDC JWKS provider failure",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.name = "OidcProviderJwksError";
    this.providerStatus = options.providerStatus;
  }
}

async function fetchRemoteJwks(
  fetchImplementation: typeof fetch,
  url: Parameters<FetchImplementation>[0],
  options: Parameters<FetchImplementation>[1],
): Promise<Response> {
  let response: Response;

  try {
    response = await fetchImplementation(url, options);
  } catch (error) {
    throw new OidcProviderJwksError(
      hasErrorName(error, "TimeoutError") ? "ERR_OIDC_JWKS_TIMEOUT" : "ERR_OIDC_JWKS_FETCH_FAILED",
      { cause: error },
    );
  }

  if (response.status !== 200) {
    throw new OidcProviderJwksError("ERR_OIDC_JWKS_HTTP_STATUS", {
      providerStatus: response.status,
    });
  }

  let jwks: unknown;

  try {
    jwks = await response.clone().json();
  } catch (error) {
    throw new OidcProviderJwksError("ERR_OIDC_JWKS_JSON_PARSE_FAILED", { cause: error });
  }

  if (!isJsonWebKeySetShape(jwks)) {
    throw new OidcProviderJwksError("ERR_OIDC_JWKS_INVALID");
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function classifyVerificationError(error: unknown): OidcTokenVerifierFailure {
  const errorCode = errorCodeOf(error);

  if (error instanceof OidcProviderJwksError) {
    return providerFailure(errorCode, error.providerStatus);
  }

  if (error instanceof errors.JOSEError) {
    if (invalidTokenErrorCodes.has(error.code)) {
      return invalidTokenFailure(error.code);
    }

    if (providerFailureErrorCodes.has(error.code)) {
      return providerFailure(error.code);
    }

    return verifierFailure(error.code);
  }

  return verifierFailure(errorCode);
}

const invalidTokenErrorCodes = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  // The caller controls the JWT header kid. If the provider returns a valid JWKS
  // that does not contain that key, treat the assertion as invalid rather than
  // retryable provider unavailability.
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

const providerFailureErrorCodes = new Set([
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWK_INVALID",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT",
]);

function invalidTokenFailure(errorCode?: string): OidcTokenVerifierFailure {
  return {
    ...(errorCode === undefined ? {} : { errorCode }),
    ok: false,
    reason: "invalid_token",
  };
}

function providerFailure(errorCode?: string, providerStatus?: number): OidcTokenVerifierFailure {
  return {
    ...(errorCode === undefined ? {} : { errorCode }),
    ok: false,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    reason: "provider_failure",
  };
}

function verifierFailure(errorCode?: string): OidcTokenVerifierFailure {
  return {
    ...(errorCode === undefined ? {} : { errorCode }),
    ok: false,
    reason: "verifier_failure",
  };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;

    if (typeof code === "string") {
      return code;
    }
  }

  return undefined;
}

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name === name
  );
}

function isJsonWebKeySetShape(input: unknown): input is { keys: unknown[] } {
  return (
    typeof input === "object" &&
    input !== null &&
    "keys" in input &&
    Array.isArray(input.keys) &&
    input.keys.every((key) => typeof key === "object" && key !== null)
  );
}
