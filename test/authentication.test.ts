import { describe, expect, it, vi } from "vitest";

import {
  githubActionsIssuerAdapter,
  githubActionsTrustedIssuer,
} from "@cyspbot/oidc-issuer-github-actions";
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

  it("passes the centrally verified token to subject-token binding validation", async () => {
    const validateSubjectTokenBinding = vi.fn(() => true);
    const capturingAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      validateSubjectTokenBinding,
    };

    await expect(
      authenticateOidcToken(
        await createOidcToken(),
        "id_token",
        request,
        "cyspbot",
        [capturingAdapter],
        fetchOidcJwksTestDouble,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(validateSubjectTokenBinding).toHaveBeenCalledOnce();
    expect(validateSubjectTokenBinding).toHaveBeenCalledWith({
      expectedAudience: "cyspbot",
      verifiedToken: {
        claims: expect.objectContaining({
          iss: "https://token.actions.githubusercontent.com",
          repository: "fixture-owner/fixture-source-repository",
        }),
        issuer: "https://token.actions.githubusercontent.com",
        resolvedKeyId: "test-key-1",
      },
    });
  });

  it.each([
    ["signature verification fails", createOidcTokenWithInvalidSignature],
    [
      "the issuer is unconfigured",
      () => createOidcToken(undefined, { issuer: "https://issuer.example" }),
    ],
  ])("does not validate subject-token binding when %s", async (_label, createToken) => {
    const validateSubjectTokenBinding = vi.fn(() => true);
    const capturingAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      validateSubjectTokenBinding,
    };

    await expect(
      authenticateOidcToken(
        await createToken(),
        "id_token",
        request,
        "cyspbot",
        [capturingAdapter],
        fetchOidcJwksTestDouble,
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(validateSubjectTokenBinding).not.toHaveBeenCalled();
  });

  it("does not validate subject-token binding when verified issuer validation fails", async () => {
    const validateSubjectTokenBinding = vi.fn(() => true);
    const mismatchedIssuerAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      resolveIssuer: () => ({
        status: "configured",
        trustedIssuer: githubActionsTrustedIssuer,
      }),
      validateSubjectTokenBinding,
    };

    await expect(
      authenticateOidcToken(
        await createOidcToken(undefined, { issuer: "https://issuer.example" }),
        "id_token",
        request,
        "cyspbot",
        [mismatchedIssuerAdapter],
        fetchOidcJwksTestDouble,
      ),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_token" });
    expect(validateSubjectTokenBinding).not.toHaveBeenCalled();
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

  it("keeps independent verifier caches for distinct injected fetch functions", async () => {
    const fetchJwksA = vi.fn(fetchOidcJwksTestDouble);
    const fetchJwksB = vi.fn(fetchOidcJwksTestDouble);
    const token = await createOidcToken();

    for (const fetchJwks of [fetchJwksA, fetchJwksB]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          authenticateOidcToken(
            token,
            "id_token",
            request,
            "cyspbot",
            [githubActionsIssuerAdapter],
            fetchJwks,
          ),
        ).resolves.toMatchObject({ ok: true });
      }
    }

    expect(fetchJwksA).toHaveBeenCalledTimes(1);
    expect(fetchJwksB).toHaveBeenCalledTimes(1);
  });

  it("keeps the default and injected-fetch verifier caches independent", async () => {
    const defaultFetchJwks = vi.fn(fetchOidcJwksTestDouble);
    const injectedFetchJwks = vi.fn(fetchOidcJwksTestDouble);
    const trustedIssuer = { ...githubActionsTrustedIssuer };
    const isolatedAdapter: OidcIssuerAdapter = {
      ...githubActionsIssuerAdapter,
      resolveIssuer: (unverifiedIssuer) =>
        unverifiedIssuer === trustedIssuer.issuer
          ? { status: "configured", trustedIssuer }
          : { status: "unhandled" },
    };
    const token = await createOidcToken();
    vi.stubGlobal("fetch", defaultFetchJwks);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          authenticateOidcToken(token, "id_token", request, "cyspbot", [isolatedAdapter]),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          authenticateOidcToken(
            token,
            "id_token",
            request,
            "cyspbot",
            [isolatedAdapter],
            injectedFetchJwks,
          ),
        ).resolves.toMatchObject({ ok: true });
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(defaultFetchJwks).toHaveBeenCalledTimes(1);
    expect(injectedFetchJwks).toHaveBeenCalledTimes(1);
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

async function createOidcTokenWithInvalidSignature(): Promise<string> {
  const token = await createOidcToken();
  const segments = token.split(".");

  if (segments.length !== 3 || segments[2] === undefined || segments[2].length === 0) {
    throw new Error("Expected a signed JWT test fixture");
  }

  const signature = segments[2];
  segments[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

  return segments.join(".");
}
