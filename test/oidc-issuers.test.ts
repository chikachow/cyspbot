import { describe, expect, it, vi } from "vitest";

import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import { configuredOidcIssuerAdapters } from "@cyspbot/token-exchange/oidc-issuers";

describe("configured OIDC issuer adapters", () => {
  it("logs a missing Fly binding once without disabling GitHub Actions", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const first = configuredOidcIssuerAdapters({});
      const second = configuredOidcIssuerAdapters({});

      expect(first).toBe(second);
      expect(resolveTrustedIssuer(first, "https://oidc.fly.io/example-org")).toBeUndefined();
      expect(
        resolveTrustedIssuer(first, "https://token.actions.githubusercontent.com"),
      ).toBeDefined();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("oidc_issuer_configuration_binding_missing", {
        binding: "FLY_OIDC_ORG_SLUGS",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("quietly configures no Fly issuer for an explicitly empty binding", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const adapters = configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "" });

      expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/example-org")).toBeUndefined();
      expect(
        resolveTrustedIssuer(adapters, "https://token.actions.githubusercontent.com"),
      ).toBeDefined();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("parses, trims, and ignores empty Fly organization entries", () => {
    const adapters = configuredOidcIssuerAdapters({
      FLY_OIDC_ORG_SLUGS: " example-org, , other-org ",
    });

    expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/example-org")).toBeDefined();
    expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/other-org")).toBeDefined();
  });

  it("creates one exact adapter for each configured Fly organization", () => {
    const adapters = configuredOidcIssuerAdapters({
      FLY_OIDC_ORG_SLUGS: "first-org,second-org",
    });
    const firstOrgAdapter = adapters[0]!;
    const secondOrgAdapter = adapters[1]!;

    expect(firstOrgAdapter).not.toBe(secondOrgAdapter);
    expect(firstOrgAdapter.resolveIssuer("https://oidc.fly.io/first-org").status).toBe(
      "configured",
    );
    expect(firstOrgAdapter.resolveIssuer("https://oidc.fly.io/second-org")).toEqual({
      status: "unhandled",
    });
    expect(secondOrgAdapter.resolveIssuer("https://oidc.fly.io/second-org").status).toBe(
      "configured",
    );
    expect(secondOrgAdapter.resolveIssuer("https://oidc.fly.io/first-org")).toEqual({
      status: "unhandled",
    });
  });

  it("omits an invalid Fly entry without affecting other issuers", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const adapters = configuredOidcIssuerAdapters({
        FLY_OIDC_ORG_SLUGS: "first-org,invalid.org,second-org,invalid.org",
      });

      expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/first-org")).toBeDefined();
      expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/second-org")).toBeDefined();
      expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/invalid.org")).toBeUndefined();
      expect(
        resolveTrustedIssuer(adapters, "https://token.actions.githubusercontent.com"),
      ).toBeDefined();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("oidc_issuer_configuration_entry_invalid", {
        binding: "FLY_OIDC_ORG_SLUGS",
        entryIndex: 1,
        reason: "unsupported_fly_issuer_path_syntax",
      });

      configuredOidcIssuerAdapters({
        FLY_OIDC_ORG_SLUGS: "first-org,invalid.org,second-org,invalid.org",
      });
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("configures no Fly issuer when every non-empty entry is invalid", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const adapters = configuredOidcIssuerAdapters({
        FLY_OIDC_ORG_SLUGS: "invalid.org, INVALID ",
      });

      expect(resolveTrustedIssuer(adapters, "https://oidc.fly.io/invalid.org")).toBeUndefined();
      expect(
        resolveTrustedIssuer(adapters, "https://token.actions.githubusercontent.com"),
      ).toBeDefined();
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("creates one adapter for duplicate organization entries", () => {
    const adapters = configuredOidcIssuerAdapters({
      FLY_OIDC_ORG_SLUGS: "example-org, example-org,other-org,example-org",
    });

    expect(configuredIssuerCount(adapters, "https://oidc.fly.io/example-org")).toBe(1);
    expect(configuredIssuerCount(adapters, "https://oidc.fly.io/other-org")).toBe(1);
  });

  it("reuses issuer identities while the Fly configuration is unchanged", () => {
    const env = { FLY_OIDC_ORG_SLUGS: "example-org" } as const;
    const first = configuredOidcIssuerAdapters(env);
    const second = configuredOidcIssuerAdapters(env);
    const firstIssuer = resolveTrustedIssuer(first, "https://oidc.fly.io/example-org");
    const secondIssuer = resolveTrustedIssuer(second, "https://oidc.fly.io/example-org");

    expect(second).toBe(first);
    expect(firstIssuer).toBeDefined();
    expect(secondIssuer).toBe(firstIssuer);
  });

  it("freezes cached adapter sets against runtime mutation", () => {
    const adapters = configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "example-org" });

    expect(Object.isFrozen(adapters)).toBe(true);
  });

  it("does not share adapters across different Fly configurations", () => {
    expect(configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "example-org" })).not.toBe(
      configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "other-org" }),
    );
  });
});

function resolveTrustedIssuer(
  adapters: readonly OidcIssuerAdapter[],
  issuer: string,
): TrustedOidcIssuer | undefined {
  for (const adapter of adapters) {
    const resolution = adapter.resolveIssuer(issuer);

    if (resolution.status === "configured") {
      return resolution.trustedIssuer;
    }
  }

  return undefined;
}

function configuredIssuerCount(adapters: readonly OidcIssuerAdapter[], issuer: string): number {
  return adapters.filter((adapter) => adapter.resolveIssuer(issuer).status === "configured").length;
}
