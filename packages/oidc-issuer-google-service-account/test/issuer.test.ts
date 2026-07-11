import { describe, expect, it } from "vitest";

import type { VerifiedOidcToken } from "@cyspbot/oidc";

import {
  googleServiceAccountIssuerAdapter,
  googleServiceAccountTrustedIssuer,
} from "../src/issuer.ts";

describe("Google service-account OIDC issuer adapter", () => {
  it("resolves only the Google Accounts issuer", () => {
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

  it("requires the authorized party to equal the service-account subject", () => {
    const validClaims = { azp: "107517467455664443765", exp: 1, sub: "107517467455664443765" };

    expect(
      googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
        claims: validClaims,
        expectedAudience: "cyspbot",
        issuer: googleServiceAccountTrustedIssuer.issuer,
      }),
    ).toBe(true);

    for (const claims of [
      { ...validClaims, azp: "different-id" },
      { ...validClaims, azp: "" },
      { ...validClaims, azp: 1 },
      { ...validClaims, azp: undefined },
      { ...validClaims, sub: "" },
      { ...validClaims, sub: 1 },
      { ...validClaims, sub: undefined },
      { ...validClaims, exp: "1" },
      { ...validClaims, exp: undefined },
    ]) {
      expect(
        googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
          // Deliberately exercise malformed runtime JWT payloads that the static type excludes.
          claims: claims as unknown as VerifiedOidcToken["claims"],
          expectedAudience: "cyspbot",
          issuer: googleServiceAccountTrustedIssuer.issuer,
        }),
      ).toBe(false);
    }

    expect(
      googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
        claims: validClaims,
        expectedAudience: "cyspbot",
        issuer: "https://issuer.example",
      }),
    ).toBe(false);
  });
});
