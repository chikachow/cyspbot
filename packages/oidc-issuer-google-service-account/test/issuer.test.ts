import { describe, expect, it } from "vitest";

import type { VerifiedOidcIdToken } from "@cyspbot/oidc";

import {
  googleServiceAccountIssuerAdapter,
  googleServiceAccountTrustedIssuer,
} from "../src/issuer.ts";

describe("Google service account OIDC issuer adapter", () => {
  it("resolves only the Google service account ID Token Issuer Identifier", () => {
    expect(
      googleServiceAccountIssuerAdapter.resolveIssuer(googleServiceAccountTrustedIssuer.issuer),
    ).toEqual({
      status: "configured",
      trustedIssuer: googleServiceAccountTrustedIssuer,
    });
    expect(googleServiceAccountIssuerAdapter.resolveIssuer("https://issuer.example")).toEqual({
      status: "unhandled",
    });
  });

  it.each(["107517467455664443765", "opaque-service-account-id"])(
    "accepts matching Subject and Authorized Party values: %s",
    (subject) => {
      const claims = {
        aud: "cyspbot",
        azp: subject,
        exp: 2,
        iat: 1,
        iss: googleServiceAccountTrustedIssuer.issuer,
        sub: subject,
      };

      expect(
        googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
          expectedAudience: "cyspbot",
          verifiedToken: createVerifiedToken(claims),
        }),
      ).toBe(true);
    },
  );

  it("rejects a missing, incorrectly typed, or mismatched Authorized Party", () => {
    const validClaims = {
      aud: "cyspbot",
      azp: "107517467455664443765",
      exp: 2,
      iat: 1,
      iss: googleServiceAccountTrustedIssuer.issuer,
      sub: "107517467455664443765",
    };

    for (const claims of [
      { ...validClaims, azp: "107517467455664443766" },
      { ...validClaims, azp: "" },
      { ...validClaims, azp: 1 },
      { ...validClaims, azp: undefined },
    ]) {
      expect(
        googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
          expectedAudience: "cyspbot",
          verifiedToken: createVerifiedToken(claims),
        }),
      ).toBe(false);
    }
  });
});

function createVerifiedToken(claims: Record<string, unknown>): VerifiedOidcIdToken {
  return {
    claims: claims as VerifiedOidcIdToken["claims"],
    issuer: googleServiceAccountTrustedIssuer.issuer,
    resolvedKeyId: "test-key-1",
  };
}
