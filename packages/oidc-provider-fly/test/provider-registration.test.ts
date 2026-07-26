import { describe, expect, it } from "vitest";

import type { VerifiedOidcIdTokenClaims } from "@cyspbot/oidc/verified-id-token";

import {
  createFlyOidcProviderRegistration,
  flyOidcIssuerIdentifierForOrganizationSlug,
} from "../src/provider-registration.ts";

const validClaims = {
  app_name: "fixture-app",
  aud: "cyspbot",
  exp: 2,
  iat: 1,
  iss: "https://oidc.fly.io/example-org",
  machine_name: "fixture-machine",
  org_name: "example-org",
  sub: "example-org:fixture-app:fixture-machine",
};

describe("Fly OIDC Provider Registration", () => {
  it.each(["a", "example-org", "example--org"])(
    "constructs an issuer from a canonical organization slug: %s",
    (organizationSlug) => {
      expect(flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug)).toBe(
        `https://oidc.fly.io/${organizationSlug}`,
      );
      expect(createFlyOidcProviderRegistration(organizationSlug)).toMatchObject({
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        issuer: `https://oidc.fly.io/${organizationSlug}`,
      });
    },
  );

  it.each([
    "",
    "-",
    "-example",
    "example-",
    "Example-Org",
    "example_org",
    "example/org",
    " example-org ",
  ])("rejects a noncanonical organization slug: %j", (organizationSlug) => {
    expect(flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug)).toBeNull();
    expect(() => createFlyOidcProviderRegistration(organizationSlug)).toThrow(
      new TypeError("unsupported Fly organization slug"),
    );
  });

  it("requires a canonical Fly Machine identity bound to the organization", () => {
    const registration = createFlyOidcProviderRegistration("example-org");

    expect(registration.idTokenProfile.validate(validClaims)).toBe(true);

    for (const claims of [
      { ...validClaims, sub: "example-org:other-app:fixture-machine" },
      { ...validClaims, org_name: "other-org" },
      { ...validClaims, app_name: "" },
      { ...validClaims, machine_name: undefined },
    ]) {
      expect(registration.idTokenProfile.validate(claims as VerifiedOidcIdTokenClaims)).toBe(false);
    }
  });
});
