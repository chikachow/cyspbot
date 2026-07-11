import { describe, expect, it } from "vitest";

import { configuredOidcIssuerAdapters } from "@cyspbot/token-exchange/oidc-issuers";

describe("configured OIDC issuer adapters", () => {
  it("reuses issuer identities while the Fly configuration is unchanged", () => {
    const env = { FLY_OIDC_ORG_SLUGS: "example-org" } as const;
    const first = configuredOidcIssuerAdapters(env);
    const second = configuredOidcIssuerAdapters(env);
    const firstResolution = first[1]?.resolveIssuer("https://oidc.fly.io/example-org");
    const secondResolution = second[1]?.resolveIssuer("https://oidc.fly.io/example-org");

    expect(second).toBe(first);
    expect(firstResolution).toMatchObject({ status: "configured" });
    expect(secondResolution).toMatchObject({ status: "configured" });
    if (firstResolution?.status === "configured" && secondResolution?.status === "configured") {
      expect(secondResolution.trustedIssuer).toBe(firstResolution.trustedIssuer);
    }
  });

  it("does not share adapters across different Fly configurations", () => {
    expect(configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "example-org" })).not.toBe(
      configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "other-org" }),
    );
  });
});
