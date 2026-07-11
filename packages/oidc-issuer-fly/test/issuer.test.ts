import { describe, expect, it } from "vitest";

import { flyIssuerAdapter } from "../src/issuer.ts";

describe("Fly.io OIDC issuer adapter", () => {
  it("resolves issuers for configured organizations", () => {
    const adapter = flyIssuerAdapter("example-org, other-org");

    expect(adapter.resolveIssuer("https://oidc.fly.io/example-org")).toEqual({
      status: "configured",
      trustedIssuer: {
        allowedSigningAlgorithms: ["RS256"],
        issuer: "https://oidc.fly.io/example-org",
        jwksUri: new URL("https://oidc.fly.io/example-org/.well-known/jwks"),
      },
    });
    expect(adapter.resolveIssuer("https://oidc.fly.io/unconfigured-org")).toEqual({
      status: "unhandled",
    });
    expect(adapter.resolveIssuer("https://issuer.example")).toEqual({ status: "unhandled" });
  });

  it("reports invalid trust configuration as unavailable", () => {
    const adapter = flyIssuerAdapter("example-org, https://issuer.example");

    expect(adapter.resolveIssuer("https://oidc.fly.io/example-org")).toEqual({
      status: "unavailable",
    });
  });

  it("requires a canonical Fly Machine identity bound to the issuer organization", () => {
    const adapter = flyIssuerAdapter("example-org");
    const claims = {
      app_id: "fly-app-id",
      app_name: "fixture-app",
      exp: 2,
      machine_id: "fly-machine-id",
      machine_name: "fixture-machine",
      machine_version: "01KWR7P5J8EP4B0QJ0M3D4P5A6",
      nbf: 1,
      org_id: "fly-org-id",
      org_name: "example-org",
      sub: "example-org:fixture-app:fixture-machine",
    };

    expect(
      adapter.validateSubjectTokenBinding({
        claims,
        expectedAudience: "cyspbot",
        issuer: "https://oidc.fly.io/example-org",
      }),
    ).toBe(true);
    expect(
      adapter.validateSubjectTokenBinding({
        claims: { ...claims, sub: "example-org:other-app:fixture-machine" },
        expectedAudience: "cyspbot",
        issuer: "https://oidc.fly.io/example-org",
      }),
    ).toBe(false);
    expect(
      adapter.validateSubjectTokenBinding({
        claims: { ...claims, org_name: "other-org" },
        expectedAudience: "cyspbot",
        issuer: "https://oidc.fly.io/example-org",
      }),
    ).toBe(false);
    expect(
      adapter.validateSubjectTokenBinding({
        claims: { ...claims, machine_id: "" },
        expectedAudience: "cyspbot",
        issuer: "https://oidc.fly.io/example-org",
      }),
    ).toBe(false);
    expect(
      adapter.validateSubjectTokenBinding({
        claims: { ...claims, azp: "other-service" },
        expectedAudience: "cyspbot",
        issuer: "https://oidc.fly.io/example-org",
      }),
    ).toBe(false);
  });
});
