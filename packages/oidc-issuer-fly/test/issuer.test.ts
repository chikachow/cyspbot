import { describe, expect, it } from "vitest";

import type { VerifiedOidcIdToken } from "@cyspbot/oidc";

import { flyIssuerAdapter, flyIssuerIdentifierForOrganizationSlug } from "../src/issuer.ts";

const validClaims = {
  app_id: "fly-app-id",
  app_name: "fixture-app",
  aud: "cyspbot",
  exp: 2,
  iat: 1,
  iss: "https://oidc.fly.io/example-org",
  machine_id: "fly-machine-id",
  machine_name: "fixture-machine",
  machine_version: "01KWR7P5J8EP4B0QJ0M3D4P5A6",
  nbf: 1,
  org_id: "fly-org-id",
  org_name: "example-org",
  sub: "example-org:fixture-app:fixture-machine",
};

describe("Fly.io OIDC issuer adapter", () => {
  it("resolves only its configured organization issuer", () => {
    const adapter = flyIssuerAdapter("example-org");

    expect(adapter.resolveIssuer("https://oidc.fly.io/example-org")).toEqual({
      status: "configured",
      trustedIssuer: {
        allowedSigningAlgorithms: ["RS256"],
        issuer: "https://oidc.fly.io/example-org",
        jwksUri: new URL("https://oidc.fly.io/example-org/.well-known/jwks"),
      },
    });
    expect(adapter.resolveIssuer("https://oidc.fly.io/other-org")).toEqual({
      status: "unhandled",
    });
    expect(adapter.resolveIssuer("https://issuer.example")).toEqual({ status: "unhandled" });
  });

  it.each(["a", "example-org", "-", "-example-", "example--org"])(
    "constructs an Issuer Identifier from accepted Fly issuer-path syntax: %s",
    (organizationSlug) => {
      expect(flyIssuerIdentifierForOrganizationSlug(organizationSlug)).toBe(
        `https://oidc.fly.io/${organizationSlug}`,
      );
      expect(() => flyIssuerAdapter(organizationSlug)).not.toThrow();
    },
  );

  it.each(["", "Example-Org", "example_org", "example.org", "example/org", " example-org "])(
    "rejects unsupported Fly issuer-path syntax: %j",
    (organizationSlug) => {
      expect(flyIssuerIdentifierForOrganizationSlug(organizationSlug)).toBeNull();
      expect(() => flyIssuerAdapter(organizationSlug)).toThrow(
        new TypeError("unsupported Fly issuer path syntax"),
      );
    },
  );

  it("requires a canonical Fly Machine identity bound to the issuer organization", () => {
    const adapter = flyIssuerAdapter("example-org");

    expect(
      adapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: createVerifiedToken(validClaims),
      }),
    ).toBe(true);
    expect(
      adapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: createVerifiedToken({
          ...validClaims,
          sub: "example-org:other-app:fixture-machine",
        }),
      }),
    ).toBe(false);
    expect(
      adapter.validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: createVerifiedToken({ ...validClaims, org_name: "other-org" }),
      }),
    ).toBe(false);
  });

  it("does not assign Fly-specific meaning to the Authorized Party claim", () => {
    expect(
      flyIssuerAdapter("example-org").validateSubjectTokenBinding({
        expectedAudience: "cyspbot",
        verifiedToken: createVerifiedToken({ ...validClaims, azp: "a-client-identifier" }),
      }),
    ).toBe(true);
  });

  it("requires the claims used by the canonical Subject binding", () => {
    const adapter = flyIssuerAdapter("example-org");

    for (const claim of ["app_name", "machine_name", "org_name"] as const) {
      for (const value of [undefined, "", 1]) {
        expect(
          adapter.validateSubjectTokenBinding({
            expectedAudience: "cyspbot",
            verifiedToken: createVerifiedToken({ ...validClaims, [claim]: value }),
          }),
        ).toBe(false);
      }
    }
  });

  it("does not require claims that do not participate in authentication", () => {
    const adapter = flyIssuerAdapter("example-org");

    for (const claim of ["app_id", "machine_id", "machine_version", "nbf", "org_id"] as const) {
      for (const value of [undefined, "", 1]) {
        expect(
          adapter.validateSubjectTokenBinding({
            expectedAudience: "cyspbot",
            verifiedToken: createVerifiedToken({ ...validClaims, [claim]: value }),
          }),
        ).toBe(true);
      }
    }
  });
});

function createVerifiedToken(claims: Record<string, unknown>): VerifiedOidcIdToken {
  return {
    claims: claims as VerifiedOidcIdToken["claims"],
    issuer: "https://oidc.fly.io/example-org",
    resolvedKeyId: "fixture-key",
  };
}
