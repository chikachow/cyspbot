import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { githubActionsTrustedIssuer } from "@cyspbot/oidc-issuer-github-actions";
import { OidcTokenVerifier } from "@cyspbot/oidc/verifier";
import { createOidcToken, testPublicJwk } from "./support/worker.ts";

describe("OidcTokenVerifier", () => {
  it("reuses its remote jwks resolver across verification requests", async () => {
    let jwksFetches = 0;
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () => {
        jwksFetches += 1;

        return Response.json(
          {
            keys: [testPublicJwk],
          },
          {
            headers: {
              "cache-control": "max-age=300",
            },
          },
        );
      },
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: true,
      token: {
        claims: {
          repository: "fixture-owner/fixture-source-repository",
        },
        issuer: githubActionsTrustedIssuer.issuer,
      },
    });
    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: true,
      token: {
        claims: {
          repository: "fixture-owner/fixture-source-repository",
        },
        issuer: githubActionsTrustedIssuer.issuer,
      },
    });
    expect(jwksFetches).toBe(1);
  });

  it("rejects tokens whose signing algorithm is not allowed", async () => {
    const token = await new SignJWT({
      event_name: "workflow_dispatch",
      ref: "refs/heads/fixture-base-branch",
      ref_type: "branch",
      repository: "fixture-owner/fixture-source-repository",
      repository_id: "123456789",
      sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("cyspbot")
      .setIssuer("https://token.actions.githubusercontent.com")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("test-secret"));
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: [testPublicJwk],
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(token)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("rejects tokens whose issuer is not GitHub Actions", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: [testPublicJwk],
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(
      verifier.verify(
        await createOidcToken(undefined, {
          issuer: "https://example.invalid",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("leaves audience policy to callers after verifying the token", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: [testPublicJwk],
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(
      verifier.verify(
        await createOidcToken(undefined, {
          audience: ["https://github.com/apps/cyspbot", "other-service"],
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      token: {
        claims: {
          aud: ["https://github.com/apps/cyspbot", "other-service"],
        },
      },
    });
  });

  it("leaves authorized-party policy to callers after verifying the token", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: [testPublicJwk],
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(
      verifier.verify(
        await createOidcToken({
          azp: "other-service",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      token: {
        claims: {
          azp: "other-service",
        },
      },
    });
  });

  it("classifies JWKS fetch throws as provider failures", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () => {
        throw new Error("network unavailable");
      },
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: false,
      reason: "provider_failure",
    });
  });

  it("classifies JWKS fetch timeouts as provider failures", async () => {
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () => {
        throw timeoutError;
      },
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: false,
      reason: "provider_failure",
    });
  });

  it("classifies non-200 JWKS responses as provider failures", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () => new Response("unavailable", { status: 503 }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: false,
      reason: "provider_failure",
    });
  });

  it("classifies malformed JWKS JSON as provider failures", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        new Response("not-json", {
          headers: {
            "content-type": "application/json",
          },
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: false,
      reason: "provider_failure",
    });
  });

  it("classifies unresolved JWKS keys as invalid tokens", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: [testPublicJwk],
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(
      verifier.verify(
        await createOidcToken(undefined, {
          kid: "caller-controlled-unknown-key",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("classifies structurally malformed JWKS as provider failures", async () => {
    const verifier = new OidcTokenVerifier({
      fetchJwks: async () =>
        Response.json({
          keys: "not-an-array",
        }),
      issuer: githubActionsTrustedIssuer,
    });

    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      ok: false,
      reason: "provider_failure",
    });
  });
});
