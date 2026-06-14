import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { githubActionsTrustedIssuer } from "@cyspbot/github-actions-oidc/issuer";
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
      claims: {
        repository: "cysp/terraform-provider-contentful",
      },
      issuer: githubActionsTrustedIssuer.issuer,
    });
    await expect(verifier.verify(await createOidcToken())).resolves.toMatchObject({
      claims: {
        repository: "cysp/terraform-provider-contentful",
      },
      issuer: githubActionsTrustedIssuer.issuer,
    });
    expect(jwksFetches).toBe(1);
  });

  it("rejects tokens whose signing algorithm is not allowed", async () => {
    const token = await new SignJWT({
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      ref_type: "branch",
      repository: "cysp/terraform-provider-contentful",
      repository_id: "123456789",
      sub: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
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

    await expect(verifier.verify(token)).resolves.toBeNull();
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
    ).resolves.toBeNull();
  });

  it("rejects tokens with untrusted additional audiences", async () => {
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
          audience: ["cyspbot", "other-service"],
        }),
      ),
    ).resolves.toBeNull();
  });

  it("rejects tokens with a mismatched authorized party", async () => {
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
    ).resolves.toBeNull();
  });
});
