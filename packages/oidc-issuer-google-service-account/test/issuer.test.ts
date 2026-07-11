import { describe, expect, it } from "vitest";

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
    expect(
      googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
        claims: { azp: "107517467455664443765", exp: 1, sub: "107517467455664443765" },
        expectedAudience: "cyspbot",
        issuer: googleServiceAccountTrustedIssuer.issuer,
      }),
    ).toBe(true);
    expect(
      googleServiceAccountIssuerAdapter.validateSubjectTokenBinding({
        claims: { azp: "different-id", exp: 1, sub: "107517467455664443765" },
        expectedAudience: "cyspbot",
        issuer: googleServiceAccountTrustedIssuer.issuer,
      }),
    ).toBe(false);
  });
});
