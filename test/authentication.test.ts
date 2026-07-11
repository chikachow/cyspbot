import { describe, expect, it, vi } from "vitest";

import { githubActionsIssuerAdapter } from "@cyspbot/oidc-issuer-github-actions";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import { authenticateOidcToken } from "@cyspbot/token-exchange/authentication";

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
