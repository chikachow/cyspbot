import { describe, expect, it, vi } from "vitest";

import {
  authorizationHeaders,
  fetchTokenExchange,
  fetchTokenExchangeWithDependencies,
  fetchTokenExchangeWithRuntime,
  fetchTokenExchangeWithEnv,
  githubInstallationAccessTokenType,
  testEnv,
  tokenExchangeRequestBody,
} from "./support/worker.ts";
import { subjectToken } from "./support/token-policy-fixtures.ts";
import { githubActionsInstallationTokenRule } from "../workers/cyspbot-token-exchange/src/policy/github-actions-token-policy-rule.ts";

describe("cyspbot-token-exchange", () => {
  it("short-circuits through the request runtime when rate limited", async () => {
    const authenticateSubjectToken = vi.fn();
    const issueInstallationToken = vi.fn();

    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: "not a form body",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      {
        authenticateSubjectToken,
        issueInstallationToken,
        rateLimit: async () => false,
      },
    );

    expect(response.status).toBe(429);
    expect(authenticateSubjectToken).not.toHaveBeenCalled();
    expect(issueInstallationToken).not.toHaveBeenCalled();
  });

  it("delegates authenticated context and normalized token request through the runtime", async () => {
    const context = {
      subjectToken,
    };
    const authenticateSubjectToken = vi.fn(async () => ({ context, ok: true }) as const);
    const issueInstallationToken = vi.fn(async () => ({
      expiresAt: "2026-05-24T00:01:00.000Z",
      ok: true as const,
      token: "runtime-test-token",
    }));

    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      {
        authenticateSubjectToken,
        issueInstallationToken,
        now: () => new Date("2026-05-24T00:00:00.000Z"),
      },
    );

    expect(authenticateSubjectToken).toHaveBeenCalledWith({
      request: expect.any(Request),
      subjectToken: expect.any(String),
      subjectTokenType: "id_token",
    });
    expect(issueInstallationToken).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        permissions: { contents: "write", pull_requests: "write" },
        resource: new URL("https://api.github.com/repos/fixture-owner/fixture-source-repository"),
        scope: "contents:write pull_requests:write",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      access_token: "runtime-test-token",
      expires_in: 60,
    });
  });

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
          githubActionsInstallationTokenRule({
            eventNames: ["workflow_dispatch"],
            id: "test-github-read-permissions",
            permissions: {
              contents: "read",
              pull_requests: "read",
            },
            ref: "refs/heads/fixture-base-branch",
            repository: "fixture-owner/fixture-source-repository",
            workflowRef:
              "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
            resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          }),
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

  it("rejects the generic JWT subject token type", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("subject_token_type", "urn:ietf:params:oauth:token-type:jwt");
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

  it("rejects token exchange requests whose OIDC audience is not cyspbot", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience: "https://github.com/apps/cyspbot",
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
    ["github app url", "https://github.com/apps/cyspbot"],
    ["unknown service audience", "fixture-other-service"],
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
          audience: ["cyspbot", "fixture-other-service"],
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
          azp: "cyspbot",
        },
        tokenOptions: {
          audience: ["cyspbot", "fixture-other-service"],
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
          azp: "cyspbot",
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
          azp: "https://github.com/apps/cyspbot",
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

  it("maps invalid oidc subject tokens to invalid token exchange requests", async () => {
    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateSubjectToken: async () => ({
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
    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateSubjectToken: async () => ({
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
    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateSubjectToken: async () => ({
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
    const response = await fetchTokenExchangeWithRuntime(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {
        authenticateSubjectToken: async () => ({
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

  it("rejects token exchange requests with non-empty audience parameters", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience: "https://github.com/apps/cyspbot",
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

  it("does not accept GitHub App URLs as the OIDC audience", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience: "https://github.com/apps/cyspbot",
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

  it.each([
    ["missing event name", { event_name: undefined }],
    ["non-string ref type", { ref_type: 123 }],
    ["missing repository", { repository: undefined }],
    ["null workflow ref", { workflow_ref: null }],
  ])("maps a policy claim with %s to invalid_target", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims }),
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

  it("maps an empty subject binding to invalid_request", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { sub: "" } }),
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

  it("ignores policy-irrelevant GitHub metadata", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { actor: 123 } }),
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

  it.each([
    [
      "repository",
      "repo:fixture-owner%2Ffixture-source-repository:ref:refs/heads/fixture-base-branch",
    ],
    ["ref", "repo:fixture-owner/fixture-source-repository:ref:refs%2Fheads%2Ffixture-base-branch"],
  ])("rejects a percent-encoded legacy subject %s", async (_component, sub) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: { sub },
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

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["non-string", 123],
  ])("does not use a %s repository id for legacy subject authorization", async (_name, id) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { repository_id: id } }),
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

  it.each([undefined, null])(
    "accepts immutable GitHub subjects when the optional owner id claim is %s",
    async (repositoryOwnerId) => {
      const response = await fetchTokenExchange("https://example.test/token", {
        body: await tokenExchangeRequestBody({
          claims: {
            repository_owner_id: repositoryOwnerId,
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
    },
  );

  it.each([
    ["mismatched string", "999999"],
    ["empty string", ""],
    ["non-string", 123],
  ])("does not use a %s owner id for legacy subject authorization", async (_name, ownerId) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          repository_owner_id: ownerId,
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

  it.each([
    ["missing repository id", { repository_id: undefined }],
    ["non-string repository id", { repository_id: 123 }],
    ["non-string repository owner id", { repository_owner_id: 123 }],
  ])("rejects an immutable GitHub subject with a %s", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          ...claims,
          sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
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

  it.each([
    [
      "repository owner id",
      {
        repository_owner_id: "999999",
        sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
    [
      "repository id",
      {
        repository_id: "999999999",
        sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
  ])("rejects immutable GitHub subjects with a mismatched signed %s", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims }),
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
