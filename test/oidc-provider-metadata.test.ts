import { describe, expect, it } from "vitest";

import {
  deriveOidcProviderConfigurationUrl,
  type OidcProviderMetadataValidationError,
  parseOidcProviderMetadata,
} from "@cyspbot/oidc/provider-metadata";
import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
} from "@cyspbot/oidc/provider-registration";

const issuer = "https://issuer.example/tenant";
const jwksUri = "https://keys.example/tenant/jwks";
const registration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: { validate: () => true },
  issuer,
});

describe("OIDC discovery URL derivation", () => {
  it.each([
    ["https://issuer.example", "https://issuer.example/.well-known/openid-configuration"],
    ["https://issuer.example/", "https://issuer.example/.well-known/openid-configuration"],
    [
      "https://issuer.example/tenant",
      "https://issuer.example/tenant/.well-known/openid-configuration",
    ],
    [
      "https://issuer.example/tenant/",
      "https://issuer.example/tenant/.well-known/openid-configuration",
    ],
  ])("appends the OIDC Discovery suffix after the issuer path", (value, expected) => {
    const parsed = parseOidcIssuerIdentifier(value);

    expect(parsed).not.toBeNull();
    expect(deriveOidcProviderConfigurationUrl(parsed!)).toHaveProperty("href", expected);
  });
});

describe("OpenID Provider Configuration validation", () => {
  it("requires exact issuer equality and a compatible advertised algorithm", () => {
    const providerMetadata = parseOidcProviderMetadata(
      {
        id_token_signing_alg_values_supported: ["RS256", "ES256"],
        issuer,
        jwks_uri: jwksUri,
      },
      registration,
    );

    expect(providerMetadata).toMatchObject({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer,
      jwksUri: new URL(jwksUri),
    });
    expect(Object.isFrozen(providerMetadata)).toBe(true);
    expect(Object.isFrozen(providerMetadata.acceptedIdTokenSigningAlgorithms)).toBe(true);

    expect(() =>
      parseOidcProviderMetadata(
        {
          id_token_signing_alg_values_supported: ["RS256"],
          issuer: `${issuer}/`,
          jwks_uri: jwksUri,
        },
        registration,
      ),
    ).toThrow();
    expect(() =>
      parseOidcProviderMetadata(
        {
          id_token_signing_alg_values_supported: ["ES256"],
          issuer,
          jwks_uri: jwksUri,
        },
        registration,
      ),
    ).toThrow();
  });

  it("retains the registration order in the accepted signing-algorithm intersection", () => {
    const multipleAlgorithmRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["ES256", "RS256"],
      idTokenProfile: { validate: () => true },
      issuer,
    });

    expect(
      parseOidcProviderMetadata(
        {
          id_token_signing_alg_values_supported: ["RS256", "ES256", "RS512"],
          issuer,
          jwks_uri: jwksUri,
        },
        multipleAlgorithmRegistration,
      ).acceptedIdTokenSigningAlgorithms,
    ).toEqual(["ES256", "RS256"]);
  });

  it.each([
    [null, "ERR_OIDC_METADATA_INVALID"],
    [[], "ERR_OIDC_METADATA_INVALID"],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: "",
      },
      "ERR_OIDC_METADATA_JWKS_URI_INVALID",
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: "not a URL",
      },
      "ERR_OIDC_METADATA_JWKS_URI_INVALID",
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: "http://keys.example/tenant/jwks",
      },
      "ERR_OIDC_METADATA_JWKS_URI_INVALID",
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: "https://user@keys.example/tenant/jwks",
      },
      "ERR_OIDC_METADATA_JWKS_URI_INVALID",
    ],
    [
      {
        id_token_signing_alg_values_supported: [],
        issuer,
        jwks_uri: jwksUri,
      },
      "ERR_OIDC_METADATA_SIGNING_ALGORITHMS_INVALID",
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256", ""],
        issuer,
        jwks_uri: jwksUri,
      },
      "ERR_OIDC_METADATA_SIGNING_ALGORITHMS_INVALID",
    ],
  ] as const)("rejects malformed OpenID Provider Configuration with %s", (input, expectedCode) => {
    expectMetadataError(input, expectedCode);
  });
});

function expectMetadataError(input: unknown, expectedCode: string): void {
  try {
    parseOidcProviderMetadata(input, registration);
  } catch (error) {
    expect(error as OidcProviderMetadataValidationError).toMatchObject({ code: expectedCode });

    return;
  }

  throw new Error(`expected OpenID Provider Configuration validation to fail with ${expectedCode}`);
}
