import { describe, expect, it } from "vitest";

import {
  authorizationHeaders,
  fetchTokenExchange,
  fetchTokenExchangeWithDependencies,
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
      scope: string;
      token_type: string;
    };
    expect(body.access_token).toBe("ghs_test_token");
    expect(body.issued_token_type).toBe(githubInstallationAccessTokenType);
    expect(body.scope).toBe("contents:write pull_requests:write");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toEqual(expect.any(Number));
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("exchanges an actions-write grant request for a token scoped to the target repository", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
          scope: "actions:write",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_workflow_dispatch_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "actions:write",
      token_type: "Bearer",
    });
  });

  it("accepts reordered scope tokens for the same permission set", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          scope: "pull_requests:write contents:write",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      scope: "contents:write pull_requests:write",
    });
  });

  it("exchanges a read permission request when token policy allows it", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody({
          form: {
            resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
            scope: "pull_requests:read contents:read",
          },
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        tokenPolicyRules: [
          {
            githubAppSlug: "cyspbot",
            permissions: {
              contents: "read",
              pull_requests: "read",
            },
            principalEventNames: ["workflow_dispatch"],
            principalRef: "refs/heads/fixture-base-branch",
            principalRepository: "fixture-owner/fixture-source-repository",
            principalWorkflowRef:
              "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
            resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          },
        ],
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_read_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:read pull_requests:read",
      token_type: "Bearer",
    });
  });

  it("rejects actions-write grant requests for unconfigured target repositories", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-target-owner/fixture-unconfigured-target",
          scope: "actions:write",
        },
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

  it("rejects the generic oauth access token type as a requested token hint", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
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

  it("rejects token exchange requests without a requested token type", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ requestedTokenType: null }),
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

  it("rejects token exchange requests whose OIDC audience is not a GitHub App URL", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience: "cyspbot",
        },
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

  it.each([
    ["missing audience", null],
    ["empty audience", ""],
    ["bare app slug", "cyspbot"],
    ["trailing slash", "https://github.com/apps/cyspbot/"],
    ["query string", "https://github.com/apps/cyspbot?x=1"],
    ["fragment", "https://github.com/apps/cyspbot#fragment"],
    ["uppercase host canonicalization", "https://GitHub.com/apps/cyspbot"],
    ["uppercase slug", "https://github.com/apps/Cyspbot"],
    ["underscore slug", "https://github.com/apps/cyspbot_app"],
    ["wrong host", "https://api.github.com/apps/cyspbot"],
  ] as const)("rejects OIDC subject tokens with %s", async (_caseName, audience) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience,
        },
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

  it("rejects OIDC subject tokens with multiple audiences", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience: [
            "https://github.com/apps/cyspbot",
            "https://github.com/apps/fixture-other-app",
          ],
        },
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

  it("rejects OIDC subject tokens with multiple audiences even when azp matches", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          azp: "https://github.com/apps/cyspbot",
        },
        tokenOptions: {
          audience: [
            "https://github.com/apps/cyspbot",
            "https://github.com/apps/fixture-other-app",
          ],
        },
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

  it("accepts OIDC subject tokens with a matching authorized party", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          azp: "https://github.com/apps/cyspbot",
        },
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
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("rejects OIDC subject tokens with a mismatched authorized party", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          azp: "https://github.com/apps/fixture-other-app",
        },
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

  it("rejects unconfigured GitHub App audiences through token policy", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience: "https://github.com/apps/fixture-other-app",
        },
        tokenOptions: {
          audience: "https://github.com/apps/fixture-other-app",
        },
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

  it("maps invalid oidc subject tokens to invalid token exchange requests", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateOidcToken: async () => ({
          ok: false,
          reason: "invalid_token",
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("maps oidc subject tokens with unknown signing keys to invalid token exchange requests", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          kid: "caller-controlled-unknown-key",
        },
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

  it("preserves authentication failure response headers", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateOidcToken: async () => ({
          ok: false,
          reason: "invalid_token",
          responseHeaders: {
            "www-authenticate": "Bearer",
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("maps oidc provider failures to temporarily unavailable", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateOidcToken: async () => ({
          ok: false,
          reason: "oidc_provider_failure",
        }),
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
  });

  it("maps oidc verifier failures to server errors", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateOidcToken: async () => ({
          ok: false,
          reason: "oidc_verifier_failure",
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "server_error",
    });
  });

  it("rejects token exchange requests without a form audience", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience: null,
        },
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

  it("rejects token exchange audience parameters that do not match the OIDC audience", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience: "https://github.com/apps/fixture-other-app",
        },
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

  it.each([
    ["bare app slug", "cyspbot"],
    ["trailing slash", "https://github.com/apps/cyspbot/"],
    ["query string", "https://github.com/apps/cyspbot?x=1"],
    ["fragment", "https://github.com/apps/cyspbot#fragment"],
    ["uppercase host canonicalization", "https://GitHub.com/apps/cyspbot"],
    ["uppercase slug", "https://github.com/apps/Cyspbot"],
    ["underscore slug", "https://github.com/apps/cyspbot_app"],
    ["repository API URL", "https://api.github.com/repos/fixture-target-owner/fixture-target"],
  ] as const)("rejects form audience parameters with %s", async (_caseName, audience) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience,
        },
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

  it("rejects duplicate non-empty audience parameters as unsupported targets", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("audience", "https://github.com/apps/cyspbot");
    body.append("audience", "https://github.com/apps/fixture-other-app");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
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

  it("rejects unsupported token exchange actor token parameters", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("actor_token", "actor");
    body.set("actor_token_type", "urn:ietf:params:oauth:token-type:jwt");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
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

  it("rejects duplicate resource parameters", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append(
      "resource",
      "https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
    );
    body.append(
      "resource",
      "https://api.github.com/repos/fixture-target-owner/fixture-other-target",
    );

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
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

  it("rejects duplicate grant type parameters as malformed requests", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("grant_type", "urn:example:grant-type:duplicate");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
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

  it("treats empty duplicate grant type parameters as omitted", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("grant_type", "");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it.each([
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ])("rejects unsupported token exchange parameter %s", async (parameter) => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set(parameter, "unsupported");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
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

  it.each([
    "actor_token",
    "actor_token_type",
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ])("treats empty unsupported token exchange parameter %s as omitted", async (parameter) => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set(parameter, "");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("rejects authorization header client authentication", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        authorization: "Basic dW5zdXBwb3J0ZWQ=",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="cyspbot"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client",
    });
  });

  it("treats empty optional scope and resource parameters as omitted", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "",
          scope: "",
        },
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
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it.each([
    ["whitespace-only scope", { scope: "  " }, "invalid_scope"],
    ["padded scope", { scope: " actions:write " }, "invalid_scope"],
    ["repeated-space scope", { scope: "contents:write  pull_requests:write" }, "invalid_scope"],
    ["tab-separated scope", { scope: "contents:write\tpull_requests:write" }, "invalid_scope"],
    ["newline-separated scope", { scope: "contents:write\npull_requests:write" }, "invalid_scope"],
    ["whitespace-only resource", { resource: "  " }, "invalid_target"],
    ["empty audience", { audience: "" }, "invalid_target"],
    ["whitespace-only audience", { audience: "  " }, "invalid_target"],
    ["padded audience", { audience: " https://github.com/apps/cyspbot " }, "invalid_target"],
    [
      "padded resource",
      { resource: " https://api.github.com/repos/fixture-target-owner/fixture-target-repository " },
      "invalid_target",
    ],
  ])("rejects invalid token policy hints: %s", async (_caseName, options, error) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ form: options }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error,
    });
  });

  it("rejects token exchange requests without a supported requested token type", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        requestedTokenType: "urn:example:token-type:unknown",
      }),
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
        claims: {
          event_name: "pull_request",
          ref: "refs/pull/15/merge",
          ref_type: "branch",
          sub: "repo:fixture-owner/fixture-source-repository:pull_request",
        },
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

  it("rejects workflow_dispatch runs from unconfigured branch refs", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          ref: "refs/heads/fixture-unconfigured-branch",
          sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-unconfigured-branch",
          workflow_ref:
            "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-unconfigured-branch",
        },
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

  it("rejects workflow_dispatch runs from unconfigured workflow files", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          workflow_ref:
            "fixture-owner/fixture-source-repository/.github/workflows/fixture-release.yml@refs/heads/fixture-base-branch",
        },
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

  it("exchanges tokens whose oidc subject uses GitHub's immutable repository format", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
        },
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
      scope: "contents:write pull_requests:write",
    });
  });

  it("does not use signed repository owner claims as policy criteria", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          repository_owner_id: "999999",
        },
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
      scope: "contents:write pull_requests:write",
    });
  });

  it("rejects push events on configured branch refs", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          event_name: "push",
          ref: "refs/heads/fixture-base-branch",
        },
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
