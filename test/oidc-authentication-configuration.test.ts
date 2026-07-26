import { describe, expect, it } from "vitest";

import {
  configuredOidcProviderRegistrations,
  validateTokenPolicyIssuerIdentifiersHaveProviderRegistrations,
} from "@cyspbot/token-exchange/oidc-authentication";
import { validateTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy";

describe("OIDC ID Token authentication configuration", () => {
  it("always registers GitHub Actions and Google service-account providers", () => {
    expect(configuredOidcProviderRegistrations({}).map(({ issuer }) => issuer)).toEqual([
      "https://token.actions.githubusercontent.com",
      "https://accounts.google.com",
    ]);
  });

  it("registers each configured Fly organization as an exact provider", () => {
    expect(
      configuredOidcProviderRegistrations({
        FLY_OIDC_ORG_SLUGS: "first-org, second-org",
      }).map(({ issuer }) => issuer),
    ).toEqual([
      "https://oidc.fly.io/first-org",
      "https://oidc.fly.io/second-org",
      "https://token.actions.githubusercontent.com",
      "https://accounts.google.com",
    ]);
  });

  it.each([
    "example-org,",
    ",example-org",
    "example-org,,other-org",
    "example-org,example-org",
    "Example-Org",
    "-",
  ])("rejects the entire Fly configuration instead of partially trusting it: %j", (value) => {
    expect(() => configuredOidcProviderRegistrations({ FLY_OIDC_ORG_SLUGS: value })).toThrow();
  });

  it("returns immutable registration sets", () => {
    expect(
      Object.isFrozen(configuredOidcProviderRegistrations({ FLY_OIDC_ORG_SLUGS: "example-org" })),
    ).toBe(true);
  });

  it("rejects policy rules whose issuer has no provider registration", () => {
    const policy = validateTokenPolicyRules([
      {
        effect: "allow",
        id: "unregistered-issuer",
        issue: {
          githubInstallationAccessToken: {
            permissions: { contents: "read" },
            resource: "https://api.github.com/repos/fixture/repository",
          },
        },
        subject: { issuer: "https://unregistered.example" },
        when: "true",
      },
    ]);

    expect(() =>
      validateTokenPolicyIssuerIdentifiersHaveProviderRegistrations(
        policy,
        configuredOidcProviderRegistrations({}),
      ),
    ).toThrow(/OIDC Issuer Identifier without a Provider Registration/u);
  });
});
