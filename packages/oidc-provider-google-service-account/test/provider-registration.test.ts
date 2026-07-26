import { describe, expect, it } from "vitest";

import type { VerifiedOidcIdTokenClaims } from "@cyspbot/oidc/verified-id-token";

import { googleServiceAccountOidcProviderRegistration } from "../src/provider-registration.ts";

describe("Google service-account OIDC Provider Registration", () => {
  it("registers the exact issuer and its provider-specific algorithm allowlist", () => {
    expect(googleServiceAccountOidcProviderRegistration).toMatchObject({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer: googleServiceAccountOidcProviderRegistration.issuer,
    });
  });

  it.each(["107517467455664443765", "opaque-service-account-id"])(
    "accepts matching sub and azp values: %s",
    (subject) => {
      expect(
        googleServiceAccountOidcProviderRegistration.idTokenProfile.validate(
          createClaims({ azp: subject, sub: subject }),
        ),
      ).toBe(true);
    },
  );

  it("rejects a missing, incorrectly typed, or mismatched azp", () => {
    for (const azp of ["different", "", 1, undefined]) {
      expect(
        googleServiceAccountOidcProviderRegistration.idTokenProfile.validate(
          createClaims({ azp, sub: "107517467455664443765" }),
        ),
      ).toBe(false);
    }
  });
});

function createClaims(overrides: Record<string, unknown>): VerifiedOidcIdTokenClaims {
  return {
    aud: "cyspbot",
    exp: 2,
    iat: 1,
    iss: googleServiceAccountOidcProviderRegistration.issuer,
    sub: "107517467455664443765",
    ...overrides,
  } as VerifiedOidcIdTokenClaims;
}
