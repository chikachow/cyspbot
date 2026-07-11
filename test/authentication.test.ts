import { describe, expect, it, vi } from "vitest";

import { flyIssuerAdapter } from "@cyspbot/oidc-issuer-fly";
import { githubActionsIssuerAdapter } from "@cyspbot/oidc-issuer-github-actions";
import { googleServiceAccountIssuerAdapter } from "@cyspbot/oidc-issuer-google-service-account";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import { authenticateOidcToken } from "@cyspbot/token-exchange/authentication";
import { configuredOidcIssuerAdapters } from "@cyspbot/token-exchange/oidc-issuers";

import { createOidcToken, fetchOidcJwksTestDouble } from "./support/oidc.ts";

const request = new Request("https://token.cyspbot.example/token");

describe("OIDC authentication", () => {
  it("authenticates a token through its configured issuer adapter", async () => {
    const result = await authenticateOidcToken(
      await createOidcToken(),
      "id_token",
      request,
      "cyspbot",
      [githubActionsIssuerAdapter],
      fetchOidcJwksTestDouble,
    );

    expect(result).toEqual({
      context: {
        subjectToken: {
          claims: expect.objectContaining({
            repository: "fixture-owner/fixture-source-repository",
          }),
          issuer: "https://token.actions.githubusercontent.com",
          resolvedKeyId: "test-key-1",
          subjectTokenType: "id_token",
        },
      },
      ok: true,
    });
  });

  it("authenticates a Fly Machine token through a configured organization issuer", async () => {
    const result = await authenticateOidcToken(
      await createOidcToken(
        {
          app_id: "fly-app-id",
          app_name: "fixture-app",
          machine_id: "fly-machine-id",
          machine_name: "fixture-machine",
          machine_version: "01KWR7P5J8EP4B0QJ0M3D4P5A6",
          nbf: Math.floor(Date.now() / 1000) - 10,
          org_id: "fly-org-id",
          org_name: "example-org",
          sub: "example-org:fixture-app:fixture-machine",
        },
        { issuer: "https://oidc.fly.io/example-org" },
      ),
      "jwt",
      request,
      "cyspbot",
      [flyIssuerAdapter("example-org")],
      fetchOidcJwksTestDouble,
    );

    expect(result).toEqual({
      context: {
        subjectToken: {
          claims: expect.objectContaining({ nbf: expect.any(Number) }),
          issuer: "https://oidc.fly.io/example-org",
          resolvedKeyId: "test-key-1",
          subjectTokenType: "jwt",
        },
      },
      ok: true,
    });
  });

  it("reuses the Fly verifier and remote JWKS cache across authentications", async () => {
    const fetchJwks = vi.fn(fetchOidcJwksTestDouble);
    const adapters = configuredOidcIssuerAdapters({ FLY_OIDC_ORG_SLUGS: "example-org" });
    const token = await createOidcToken(
      {
        app_id: "fly-app-id",
        app_name: "fixture-app",
        machine_id: "fly-machine-id",
        machine_name: "fixture-machine",
        machine_version: "01KWR7P5J8EP4B0QJ0M3D4P5A6",
        nbf: Math.floor(Date.now() / 1000) - 10,
        org_id: "fly-org-id",
        org_name: "example-org",
        sub: "example-org:fixture-app:fixture-machine",
      },
      { issuer: "https://oidc.fly.io/example-org" },
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        authenticateOidcToken(token, "jwt", request, "cyspbot", adapters, fetchJwks),
      ).resolves.toMatchObject({ ok: true });
    }

    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("authenticates a Google service-account ID token", async () => {
    const issuer = "https://accounts.google.com";
    const uniqueId = "107517467455664443765";
    const result = await authenticateOidcToken(
      await createOidcToken({ azp: uniqueId, sub: uniqueId }, { issuer }),
      "id_token",
      request,
      "cyspbot",
      [googleServiceAccountIssuerAdapter],
      fetchOidcJwksTestDouble,
    );

    expect(result).toMatchObject({
      context: { subjectToken: { issuer, subjectTokenType: "id_token" } },
      ok: true,
    });
  });

  it("rejects a Google ID token whose authorized party does not match its subject", async () => {
    const issuer = "https://accounts.google.com";
    const result = await authenticateOidcToken(
      await createOidcToken(
        { azp: "different-service-account", sub: "107517467455664443765" },
        { issuer },
      ),
      "id_token",
      request,
      "cyspbot",
      [googleServiceAccountIssuerAdapter],
      fetchOidcJwksTestDouble,
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_token",
      responseHeaders: { "www-authenticate": "Bearer" },
    });
  });

  it.each([
    ["an unknown issuer", () => createOidcToken(undefined, { issuer: "https://issuer.example" })],
    ["a malformed token", () => Promise.resolve("not-a-jwt")],
  ])("rejects %s without fetching JWKS", async (_label, createToken) => {
    const fetchJwks = vi.fn(fetchOidcJwksTestDouble);
    const token = await createToken();

    await expect(
      authenticateOidcToken(
        token,
        "id_token",
        request,
        "cyspbot",
        [githubActionsIssuerAdapter],
        fetchJwks,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_token",
      responseHeaders: { "www-authenticate": "Bearer" },
    });
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it("reports a configured issuer with invalid trust configuration as a verifier failure", async () => {
    const invalidAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      resolveIssuer: () => ({ status: "unavailable" }),
    };
    const fetchJwks = vi.fn(fetchOidcJwksTestDouble);

    await expect(
      authenticateOidcToken(
        await createOidcToken(),
        "id_token",
        request,
        "cyspbot",
        [invalidAdapter],
        fetchJwks,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "oidc_verifier_failure",
      responseHeaders: { "www-authenticate": "Bearer" },
    });
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it("does not select an adapter that declines the token issuer", async () => {
    const decliningAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      resolveIssuer: () => ({ status: "unhandled" }),
    };
    const fetchJwks = vi.fn(fetchOidcJwksTestDouble);

    await expect(
      authenticateOidcToken(
        await createOidcToken(),
        "id_token",
        request,
        "cyspbot",
        [decliningAdapter],
        fetchJwks,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_token",
      responseHeaders: { "www-authenticate": "Bearer" },
    });
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it.each([
    ["a mismatched audience", () => createOidcToken(undefined, { audience: "another-service" })],
    ["a mismatched authorized party", () => createOidcToken({ azp: "another-service" })],
  ])("rejects %s", async (_label, createToken) => {
    const result = await authenticateOidcToken(
      await createToken(),
      "id_token",
      request,
      "cyspbot",
      [githubActionsIssuerAdapter],
      fetchOidcJwksTestDouble,
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_token",
      responseHeaders: { "www-authenticate": "Bearer" },
    });
  });
});
