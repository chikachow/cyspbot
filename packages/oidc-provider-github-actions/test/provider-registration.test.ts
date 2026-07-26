import { describe, expect, it } from "vitest";

import { githubActionsOidcProviderRegistration } from "../src/provider-registration.ts";

describe("GitHub Actions OIDC Provider Registration", () => {
  const claims = {
    aud: "cyspbot",
    exp: 2,
    iat: 1,
    iss: githubActionsOidcProviderRegistration.issuer,
    sub: "repo:fixture-owner/fixture-repository:ref:refs/heads/main",
  };

  it("registers the exact issuer and its provider-specific algorithm allowlist", () => {
    expect(githubActionsOidcProviderRegistration).toMatchObject({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer: githubActionsOidcProviderRegistration.issuer,
    });
  });

  it("accepts an absent azp or an azp equal to the already-verified audience", () => {
    expect(githubActionsOidcProviderRegistration.idTokenProfile.validate(claims)).toBe(true);
    expect(
      githubActionsOidcProviderRegistration.idTokenProfile.validate({
        ...claims,
        azp: "cyspbot",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched authorized party", () => {
    expect(
      githubActionsOidcProviderRegistration.idTokenProfile.validate({
        ...claims,
        azp: "other-service",
      }),
    ).toBe(false);
  });
});
