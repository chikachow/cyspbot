import type {
  OidcIdTokenSigningAlgorithm,
  OidcIssuerIdentifier,
  OidcProviderRegistration,
} from "./provider-registration.ts";

export interface ValidatedOidcProviderMetadata {
  readonly acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  readonly issuer: OidcIssuerIdentifier;
  readonly jwksUri: URL;
}

/**
 * Derives the OpenID Provider Configuration request URL defined by OpenID
 * Connect Discovery 1.0, section 4.1. The suffix is appended after any issuer
 * path; this is intentionally not RFC 8414's insertion-before-path algorithm.
 */
export function deriveOidcProviderConfigurationUrl(issuer: OidcIssuerIdentifier): URL {
  const issuerWithoutTerminatingSlash = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;

  return new URL(`${issuerWithoutTerminatingSlash}/.well-known/openid-configuration`);
}

export function parseOidcProviderMetadata(
  input: unknown,
  providerRegistration: OidcProviderRegistration,
): ValidatedOidcProviderMetadata {
  if (!isObject(input)) {
    throw new OidcProviderMetadataValidationError("ERR_OIDC_METADATA_INVALID");
  }

  if (input["issuer"] !== providerRegistration.issuer) {
    throw new OidcProviderMetadataValidationError("ERR_OIDC_METADATA_ISSUER_MISMATCH");
  }

  const jwksUri = parseHttpsUrl(input["jwks_uri"]);

  if (jwksUri === null) {
    throw new OidcProviderMetadataValidationError("ERR_OIDC_METADATA_JWKS_URI_INVALID");
  }

  const advertisedAlgorithms = input["id_token_signing_alg_values_supported"];

  if (
    !Array.isArray(advertisedAlgorithms) ||
    advertisedAlgorithms.length === 0 ||
    !advertisedAlgorithms.every(
      (algorithm) => typeof algorithm === "string" && algorithm.length > 0,
    )
  ) {
    throw new OidcProviderMetadataValidationError("ERR_OIDC_METADATA_SIGNING_ALGORITHMS_INVALID");
  }

  const acceptedIdTokenSigningAlgorithms =
    providerRegistration.acceptedIdTokenSigningAlgorithms.filter((algorithm) =>
      advertisedAlgorithms.includes(algorithm),
    );

  if (acceptedIdTokenSigningAlgorithms.length === 0) {
    throw new OidcProviderMetadataValidationError(
      "ERR_OIDC_METADATA_NO_COMPATIBLE_SIGNING_ALGORITHM",
    );
  }

  return Object.freeze({
    acceptedIdTokenSigningAlgorithms: Object.freeze([...acceptedIdTokenSigningAlgorithms]),
    issuer: providerRegistration.issuer,
    jwksUri,
  });
}

export class OidcProviderMetadataValidationError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("invalid OpenID Provider Configuration");
    this.code = code;
    this.name = "OidcProviderMetadataValidationError";
  }
}

function parseHttpsUrl(input: unknown): URL | null {
  if (typeof input !== "string" || input.length === 0) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  return url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
    ? url
    : null;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
