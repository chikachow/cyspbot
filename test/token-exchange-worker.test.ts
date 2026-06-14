import { describe, expect, it } from "vitest";

import {
  authorizationHeaders,
  fetchTokenExchange,
  fetchTokenExchangeWithEnv,
  githubInstallationAccessTokenType,
  testEnv,
  tokenExchangeRequestBody,
} from "./support/worker.ts";

describe("cyspbot-token-exchange", () => {
  it("does not expose the removed claims endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/github/claims", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: 404,
      title: "Not Found",
      type: "about:blank",
    });
  });

  it("does not expose the legacy installation token endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/github/installations/token", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: 404,
      title: "Not Found",
      type: "about:blank",
    });
  });

  it("exchanges a github actions oidc token at the token exchange endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
      issued_token_type: string;
      token_type: string;
    };
    expect(body.access_token).toBe("ghs_test_token");
    expect(body.issued_token_type).toBe(githubInstallationAccessTokenType);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toEqual(expect.any(Number));
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("accepts the generic oauth access token type as a requested token hint", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(
        undefined,
        "urn:ietf:params:oauth:token-type:access_token",
      ),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      token_type: "Bearer",
    });
  });

  it("rejects token exchange requests whose oidc audience does not match cyspbot", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(undefined, githubInstallationAccessTokenType, {
        audience: "other-service",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects token exchange requests without a supported requested token type", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(undefined, "urn:example:token-type:unknown"),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rate limits token exchange requests before parsing the request body", async () => {
    const response = await fetchTokenExchangeWithEnv(
      "https://example.test/token",
      {
        body: "not a form body",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        ...testEnv,
        TOKEN_EXCHANGE_RATE_LIMIT: {
          limit: async () => ({ success: false }),
        },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
  });

  it("rejects oversized token exchange request bodies", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: `grant_type=x&subject_token=${"x".repeat(64 * 1024)}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("maps disallowed token exchange contexts to oauth token errors", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        event_name: "pull_request",
        ref: "refs/pull/15/merge",
        ref_type: "branch",
        sub: "repo:cysp/terraform-provider-contentful:pull_request",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("rejects workflow_dispatch runs that do not target the default branch ref", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        ref: "refs/heads/release-candidate",
        sub: "repo:cysp/terraform-provider-contentful:ref:refs/heads/release-candidate",
        workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/release-candidate",
        job_workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/release-candidate",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("does not currently authorize workflow_dispatch runs by workflow file path", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        job_workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/release.yml@refs/heads/main",
        workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/release.yml@refs/heads/main",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
    });
  });

  it("exchanges tokens whose oidc subject uses GitHub's immutable repository format", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        sub: "repo:cysp@555555/terraform-provider-contentful@123456789:ref:refs/heads/main",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it("rejects token exchange when signed repository owner claims do not match live repository metadata", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        repository_owner_id: "999999",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("rejects push events on the current default branch", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        event_name: "push",
        ref: "refs/heads/main",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });
});
