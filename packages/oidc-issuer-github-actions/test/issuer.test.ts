import { describe, expect, it } from "vitest";

import { githubActionsIssuerAdapter, githubActionsTrustedIssuer } from "../src/issuer.ts";

describe("GitHub Actions OIDC issuer adapter", () => {
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
          claims: {
            azp: "cyspbot",
            exp: 1,
            sub: "repo:fixture-owner/fixture-repository:ref:refs/heads/main",
          },
          issuer: githubActionsTrustedIssuer.issuer,
          resolvedKeyId: "fixture-key",
        },
      }),
    ).toBe(true);
  });

  it("rejects missing subjects and mismatched authorized parties", () => {
    expect(
      githubActionsIssuerAdapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: {
          claims: { exp: 1, sub: "" },
          issuer: githubActionsTrustedIssuer.issuer,
          resolvedKeyId: "fixture-key",
        },
      }),
    ).toBe(false);
    expect(
      githubActionsIssuerAdapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: {
          claims: {
            azp: "other-service",
            exp: 1,
            sub: "repo:fixture-owner/fixture-repository:ref:refs/heads/main",
          },
          issuer: githubActionsTrustedIssuer.issuer,
          resolvedKeyId: "fixture-key",
        },
      }),
    ).toBe(false);
  });
});
