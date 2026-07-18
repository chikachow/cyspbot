import { describe, expect, it } from "vitest";

import { githubActionsIssuerAdapter, githubActionsTrustedIssuer } from "../src/issuer.ts";

describe("GitHub Actions OIDC issuer adapter", () => {
  const verifiedToken = {
    claims: {
      aud: "cyspbot",
      exp: 2,
      iat: 1,
      iss: githubActionsTrustedIssuer.issuer,
      sub: "repo:fixture-owner/fixture-repository:ref:refs/heads/main",
    },
    issuer: githubActionsTrustedIssuer.issuer,
    resolvedKeyId: "fixture-key",
  };

  it("resolves only the configured GitHub Actions issuer", () => {
    expect(githubActionsIssuerAdapter.resolveIssuer(githubActionsTrustedIssuer.issuer)).toEqual({
      status: "configured",
      trustedIssuer: githubActionsTrustedIssuer,
    });
    expect(githubActionsIssuerAdapter.resolveIssuer("https://issuer.example")).toEqual({
      status: "unhandled",
    });
  });

  it("accepts subject tokens bound to the expected audience", () => {
    expect(
      githubActionsIssuerAdapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: {
          ...verifiedToken,
          claims: { ...verifiedToken.claims, azp: "cyspbot" },
        },
      }),
    ).toBe(true);
    expect(
      githubActionsIssuerAdapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken,
      }),
    ).toBe(true);
  });

  it("rejects mismatched authorized parties", () => {
    expect(
      githubActionsIssuerAdapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: {
          ...verifiedToken,
          claims: { ...verifiedToken.claims, azp: "other-service" },
        },
      }),
    ).toBe(false);
  });
});
