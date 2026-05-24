import { createHmac, createPrivateKey } from "node:crypto";

import type { Env } from "../src/env.ts";
import type { AuthenticateRequestResult } from "../src/worker/authentication.ts";
import { createApp } from "../src/worker/app.ts";
import d1SchemaSql from "../migrations/0001_dashboard_d1_recut.sql?raw";
import { env } from "cloudflare:workers";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

const workerEnv = env as unknown as Env;

const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC27Vu1+aKPooBG
8zJHy9cbx0FAO26Fk2HnzYpl/Tm7POL6Pxzht2HO6GOTEv7OKz7o0TzG6XdDz5ci
+IP6eKHVPPRupH7wbYOqxp4zRhPMaVaaJFQ27ApXANOKxz+UBjGe/JMFQaTA/O3k
NJ0WoNXlMUDDWlLzmkz767EmqkrOeDO+/I11BSw3r07Kheu1C5LZ/Bv/IE1JINsV
NzzN4cVHXmI9HXkLAHwDzeUs0cu7ar6Vxfl4ON5lDptwKptntfU4nn7p1zZK9q0Q
QVjPRVwhaLy+XofSoO57xf5euJyYDxa9T3iqAZO1WZ7kXHIZUY6Mrws6NVmbt2cp
BM77ECyLAgMBAAECggEAA3x4j/pG99fP/AosfiPLYLMmcjPvwknxxrorFhCCZigd
50kGouKc0ZWqOCZXhtRaKZO7RcszQ66UIc18rmxYITk9K1KlPK3JoZqRb0a5n96u
ENf6ZuWOuOPCJFXxxz9q+K21m5cJrcfkPMIn8EN2cBzFMDPressJBpASWztJm6+0
g6uTBt6l9CU3ObvjyORefXSfPwkhGKNfvgy75/VSlddcDAV+wjH14JdqWdMlntHH
fMRPboYC3cvik6YsWb6qNGfjXz+Hzeba7D13y+QGYWrdfBfavbTHqkgZKas7AmyY
Tdrl1VlWD+h03Tec3DkhIxrdeA1+Wf+wmBjonmURSQKBgQDgrpsNIe8Ee/TT7VMz
4fb3GfplRv0lshPfYW5W4ULEga2Oviz32BtSPhgG6NFZwIJ+MTxQhvPwGMQuYfqR
CR3SG9O+m+kr4CLJJLxQ0RHBQ9VtP9wVOKqUiNkE9ez7mqx3/RF8oenNUPkAUFso
1O0d9p87H5xpGZ43NVupfGpL1wKBgQDQbM0rYOK+1YToh7RanFLW0MpvQcvQHjsF
qJ56yoza0f/3FNyrEy7vcwzI5m+mQLfRMLkrvljv+iavjylG2cZDr+/lK4QQRcyM
LQctBJeSXw/y2+dS7AvL5XJQkRe8hpZTpFNdVsOnzWrqEl674CrFZKo89ORIirLJ
7GJJgZTubQKBgQDF2FrGNKRREYnj9+41GHws2N5Jwjn1sJqZMCVGMbNmcD5RHJti
XxSn1e+4XdjDLKZ70oUm777sJBLUOQi4IAv3UPOiu42WSha3gjak/4Sf50iPnBUD
RtPGWb6oBJn6cBgAzIJSegzz86JfqWKsUNq/cMSD/nDvh1Rvjve5BcpgHwKBgAKi
7bF3x0Z8svKyDMD8qzuWZokjvu1CBKMcr+yDtWZrM56vf98WHgjfXrEH4S+sL+cQ
g7ce8EcQ1f5whCgmRxDCH/m5JDGEgILhau7R2Qz78Nq0l2eAHuIUY+7K9w7mcO5b
7MYIe+8adRjC5LnhqwjWLiUZP+3++yX8vH2LixO9AoGATPqMHTEaIrIh999ahqmv
OulHU1mIPsNEzbagWNwCmDJB5+MJPE76j59Gg1NMVmRQvDOnhktjCdyr7cLoSyb5
cT0XqIpKa8tyk2RAMjqM52QwttVzRnDjhqrpyM+9HsPyP7huvTlkpwLBE8GR7cP3
guigOK0SOM7v+1ceZuh/bm8=
-----END PRIVATE KEY-----
`;
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const githubInstallationAccessTokenType = "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const testRepository = "cysp/terraform-provider-contentful";
const testRepositoryId = "123456789";
const testInstallationId = 67890;
const testRepositoryOwnerId = "555555";
const testRepositoryVisibility = "private";
const testDashboardAccessToken = "ghu_test_token";
const testDashboardRefreshToken = "ghr_test_token";
const testNow = new Date("2026-05-24T00:00:00.000Z");

const testApp = createApp({
  authenticateOidcToken: authenticateTestOidcToken,
  authenticateRequest: authenticateTestRequest,
  fetch: fetchGitHubTestDouble,
  now: () => testNow,
});

function fetchWorker(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const handler = testApp.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(
      new Request(input, init) as Parameters<typeof handler>[0],
      workerEnv,
      {} as ExecutionContext,
    ),
  );
}

function authorizationHeaders(
  overrides?: Partial<Record<string, string>>,
): Promise<Record<string, string>> {
  return createOidcToken(overrides).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

async function createOidcToken(overrides?: Partial<Record<string, string>>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = createPrivateKey(testPrivateKeyPem);
  const { sub, ...payloadOverrides } = overrides ?? {};

  return new SignJWT({
    actor: "dependabot[bot]",
    base_ref: "",
    event_name: "workflow_dispatch",
    head_ref: "",
    job_workflow_ref:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    ref: "refs/heads/main",
    ref_type: "branch",
    repository: "cysp/terraform-provider-contentful",
    repository_id: "123456789",
    repository_owner_id: "555555",
    repository_visibility: "private",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflow: "update indirect dependencies",
    workflow_ref:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setAudience("cyspbot")
    .setIssuer("https://token.actions.githubusercontent.com")
    .setIssuedAt(now - 10)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 300)
    .setSubject(sub ?? "repo:cysp/terraform-provider-contentful:ref:refs/heads/main")
    .sign(privateKey);
}

async function authenticateTestRequest(
  request: Request,
  env: Env,
): Promise<AuthenticateRequestResult> {
  const authorization = request.headers.get("authorization");
  const [scheme, token] = authorization?.split(/\s+/, 2) ?? [];

  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
    return {
      httpStatus: 401,
      ok: false,
      responseHeaders: {
        "www-authenticate": "Bearer",
      },
    };
  }

  return authenticateTestOidcToken(token, request, env);
}

async function authenticateTestOidcToken(
  token: string,
  _request: Request,
  _env: Env,
): Promise<AuthenticateRequestResult> {
  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(token.split(".")[1] ?? "")),
  ) as Record<string, unknown>;
  const subject = stringClaim(payload, "sub");
  const parsedSubject = parseGitHubOidcSubject(subject);

  return {
    context: {
      issuerRegistration: {
        allowedAlgorithms: ["RS256"],
        audience: "cyspbot",
        defaultFreshMs: 300_000,
        issuer: "https://token.actions.githubusercontent.com",
        jwksUri: "https://token.actions.githubusercontent.com/.well-known/jwks",
        mapPrincipal: () => null,
        maxBackoffMs: 300_000,
        maxFreshMs: 900_000,
        minFreshMs: 60_000,
        principalKind: "github-actions",
        refreshBackoffBaseMs: 5_000,
        requireKid: true,
        staleWhileErrorMs: 600_000,
      },
      principal: {
        actor: optionalStringClaim(payload, "actor"),
        baseRef: optionalStringClaim(payload, "base_ref"),
        environment: optionalStringClaim(payload, "environment"),
        eventName: stringClaim(payload, "event_name"),
        headRef: optionalStringClaim(payload, "head_ref"),
        jobWorkflowRef: optionalStringClaim(payload, "job_workflow_ref"),
        rawSubject: subject,
        ref: optionalStringClaim(payload, "ref"),
        refType: optionalStringClaim(payload, "ref_type"),
        repository: stringClaim(payload, "repository"),
        repositoryId: stringClaim(payload, "repository_id"),
        repositoryOwnerId: optionalStringClaim(payload, "repository_owner_id"),
        repositoryVisibility: optionalStringClaim(payload, "repository_visibility"),
        runAttempt: optionalStringClaim(payload, "run_attempt"),
        runId: optionalStringClaim(payload, "run_id"),
        sha: optionalStringClaim(payload, "sha"),
        subjectContextKind: parsedSubject.contextKind,
        subjectContextValue: parsedSubject.contextValue,
        subjectRepository: parsedSubject.repository,
        type: "github-actions",
        workflow: optionalStringClaim(payload, "workflow"),
        workflowRef: optionalStringClaim(payload, "workflow_ref"),
      },
      resolvedKeyId: "test-key-1",
    },
    ok: true,
  };
}

async function fetchGitHubTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;

  if (
    url.hostname === "github.com" &&
    request.method === "POST" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return oauthTokenResponse(new TextDecoder().decode(await request.arrayBuffer()));
  }

  if (url.hostname !== "example.test" && url.hostname !== "api.github.com") {
    return new Response(null, { status: 404 });
  }

  const apiPath = url.pathname.replace(/^\/__test\/github/u, "");

  if (request.headers.get("authorization") === null) {
    return new Response(null, { status: 401 });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/installation`) {
    return Response.json({ id: testInstallationId });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}`) {
    return Response.json({
      default_branch: "main",
      id: Number.parseInt(testRepositoryId, 10),
      owner: {
        id: Number.parseInt(testRepositoryOwnerId, 10),
      },
      visibility: testRepositoryVisibility,
    });
  }

  if (
    request.method === "POST" &&
    apiPath === `/app/installations/${testInstallationId}/access_tokens`
  ) {
    const body = (await request.json()) as Record<string, unknown>;
    const permissions = body["permissions"];

    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("x-github-stateless-s2s-token") !== "enabled" ||
      !Array.isArray(body["repository_ids"]) ||
      body["repository_ids"][0] !== Number.parseInt(testRepositoryId, 10) ||
      permissions === null ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      return new Response(null, { status: 500 });
    }

    const requestedPermissions = permissions as Record<string, unknown>;

    if (
      Object.keys(requestedPermissions).length === 1 &&
      requestedPermissions["metadata"] === "read"
    ) {
      return Response.json(
        {
          expires_at: "2030-01-01T00:00:00Z",
          permissions: {
            metadata: "read",
          },
          token: "ghs_test_metadata_token",
        },
        { status: 201 },
      );
    }

    if (
      Object.keys(requestedPermissions).length !== 2 ||
      requestedPermissions["contents"] !== "write" ||
      requestedPermissions["pull_requests"] !== "write"
    ) {
      return new Response(null, { status: 500 });
    }

    return Response.json(
      {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        token: "ghs_test_token",
      },
      { status: 201 },
    );
  }

  if (request.method === "GET" && apiPath === "/user") {
    return Response.json({
      id: 42,
      login: "sally",
    });
  }

  if (request.method === "GET" && apiPath === "/user/installations") {
    return Response.json({
      installations: [{ id: testInstallationId }],
    });
  }

  if (
    request.method === "GET" &&
    apiPath === `/user/installations/${testInstallationId}/repositories`
  ) {
    return Response.json({
      repositories: [
        {
          full_name: testRepository,
          id: Number.parseInt(testRepositoryId, 10),
          name: "terraform-provider-contentful",
          owner: {
            login: "cysp",
          },
          permissions: {
            admin: true,
            pull: true,
            push: true,
          },
          private: true,
        },
      ],
    });
  }

  return new Response(`No test GitHub response for ${request.method} ${path}`, { status: 404 });
}

function oauthTokenResponse(body: string): Response {
  const parsedBody = new URLSearchParams(body);

  if (parsedBody.get("grant_type") === "refresh_token") {
    if (parsedBody.get("refresh_token") !== testDashboardRefreshToken) {
      return new Response(null, { status: 400 });
    }
  } else if (parsedBody.get("code") !== "test-dashboard-code") {
    return new Response(null, { status: 400 });
  }

  return Response.json({
    access_token: testDashboardAccessToken,
    expires_in: 28800,
    refresh_token: testDashboardRefreshToken,
    refresh_token_expires_in: 15897600,
  });
}

function stringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];

  if (typeof value !== "string") {
    throw new Error(`missing test claim ${name}`);
  }

  return value;
}

function optionalStringClaim(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];

  return typeof value === "string" ? value : null;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4 || 4)) % 4), "=");
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseGitHubOidcSubject(subject: string): {
  contextKind: string | null;
  contextValue: string | null;
  repository: string | null;
} {
  const match = /^repo:([^:]+):([^:]+)(?::(.+))?$/u.exec(subject);

  if (match === null) {
    return {
      contextKind: null,
      contextValue: null,
      repository: null,
    };
  }

  const [, repository, contextKind, rawContextValue] = match;

  return {
    contextKind: contextKind ?? null,
    contextValue: rawContextValue === undefined ? null : decodeURIComponent(rawContextValue),
    repository: repository === undefined ? null : decodeURIComponent(repository),
  };
}

function githubWebhookHeaders(
  body: string,
  secret: string,
  event = "installation_repositories",
): Record<string, string> {
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  return {
    "content-type": "application/json",
    "x-github-delivery": "delivery-123",
    "x-github-event": event,
    "x-hub-signature-256": `sha256=${signature}`,
  };
}

async function tokenExchangeRequestBody(
  overrides?: Partial<Record<string, string>>,
  requestedTokenType = githubInstallationAccessTokenType,
): Promise<string> {
  const subjectToken = await createOidcToken(overrides);

  return new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: requestedTokenType,
    subject_token: subjectToken,
    subject_token_type: oidcIdTokenType,
  }).toString();
}

function cookieHeaderValue(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = response.headers.get("set-cookie");

  return combined === null ? [] : combined.split(/,(?=\s*[A-Za-z0-9_]+=)/u);
}

describe("cyspbot worker", () => {
  beforeAll(async () => {
    for (const statement of d1SchemaSql.split(/;\s*(?:\n|$)/u)) {
      if (statement.trim().length > 0) {
        await workerEnv.DB.prepare(statement).run();
      }
    }
  });

  it("redirects the service root to the dashboard", async () => {
    const response = await fetchWorker("https://example.test/", {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns minimal problem details for missing authentication", async () => {
    const response = await fetchWorker("https://example.test/github/claims", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      status: 401,
      title: "Unauthorized",
      type: "about:blank",
    });
  });

  it("verifies caller claims without evaluating full token mint policy", async () => {
    const response = await fetchWorker("https://example.test/github/claims", {
      headers: await authorizationHeaders({
        event_name: "pull_request",
        ref: "refs/pull/12/merge",
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      event_name: "pull_request",
      ref: "refs/pull/12/merge",
      repository: "cysp/terraform-provider-contentful",
      repository_id: "123456789",
    });
  });

  it("accepts tokens whose payload contains non-ascii claim values", async () => {
    const response = await fetchWorker("https://example.test/github/claims", {
      headers: await authorizationHeaders({
        workflow: "déploiement principal",
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      event_name: "workflow_dispatch",
      ref: "refs/heads/main",
      repository: "cysp/terraform-provider-contentful",
      repository_id: "123456789",
    });
  });

  it("does not expose the legacy installation token endpoint", async () => {
    const response = await fetchWorker("https://example.test/github/installations/token", {
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

  it("exchanges a github actions oidc token at the sts endpoint", async () => {
    const response = await fetchWorker("https://example.test/token", {
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
    const response = await fetchWorker("https://example.test/token", {
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

  it("rejects token exchange requests without a supported requested token type", async () => {
    const response = await fetchWorker("https://example.test/token", {
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

  it("rejects disallowed events", async () => {
    const response = await fetchWorker("https://example.test/token", {
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

  it("maps disallowed token exchange contexts to oauth token errors", async () => {
    const response = await fetchWorker("https://example.test/token", {
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
    const response = await fetchWorker("https://example.test/token", {
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

  it("rejects token exchange when the oidc subject repository does not match the caller repository", async () => {
    const response = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        sub: "repo:cysp/other-repo:ref:refs/heads/main",
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

  it("rejects push events away from the current default branch", async () => {
    const response = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        event_name: "push",
        ref: "refs/heads/feature-branch",
        sub: "repo:cysp/terraform-provider-contentful:ref:refs/heads/feature-branch",
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

  it("rejects pushes on the current default branch", async () => {
    const response = await fetchWorker("https://example.test/token", {
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

  it("rejects webhook payloads with an invalid signature", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: {
        id: 67890,
      },
      repositories_added: [],
      repositories_removed: [],
    });
    const headers = githubWebhookHeaders(body, "wrong-secret");

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      status: 401,
      title: "Unauthorized",
      type: "about:blank",
    });
  });

  it("accepts signed github ping webhook deliveries without an installation id", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
        app_id: 2419473,
        config: {
          content_type: "json",
          insecure_ssl: "0",
          secret: "********",
          url: "https://cyspbot.chikachow.org/github/webhooks",
        },
        created_at: "2026-05-23T13:00:07Z",
        deliveries_url: "https://api.github.com/app/hook/deliveries",
        events: ["installation_target"],
        id: 629275372,
        name: "web",
        type: "App",
        updated_at: "2026-05-23T13:00:07Z",
      },
      hook_id: 629275372,
      zen: "Speak like a human.",
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret", "ping");

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      event: "ping",
    });
  });

  it("rejects webhook payloads with a non-JSON content type", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: {
        id: 67890,
      },
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret"),
      "content-type": "text/plain",
    };

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      status: 415,
      title: "Unsupported Media Type",
      type: "about:blank",
    });
  });

  it("rejects webhook payloads larger than 256 KiB", async () => {
    const body = JSON.stringify({
      installation: {
        id: 67890,
      },
      payload: "x".repeat(256 * 1024),
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret");

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      status: 413,
      title: "Payload Too Large",
      type: "about:blank",
    });
  });

  it("routes signed webhook payloads to the installation durable object", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: {
        id: 67890,
      },
      repositories_added: [],
      repositories_removed: [],
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret");

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
    });
  });

  it("does not expose the obsolete durable object migration endpoint", async () => {
    const response = await fetchWorker(
      "https://example.test/internal/durable-objects/github-installations/migrate",
      {
        body: JSON.stringify({
          object_ids: [workerEnv.GITHUB_INSTALLATION.idFromName("67890").toString()],
        }),
        headers: {
          authorization: "Bearer test-maintenance-token",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
  });

  it("restarts stateful dashboard login from the GitHub App setup URL", async () => {
    const response = await fetchWorker(
      "https://example.test/github/setup?installation_id=135120833&setup_action=install",
      {
        redirect: "manual",
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login/github?return_to=%2Fdashboard");
    expect(responseSetCookies(response)).toContain(
      "__Host-cyspbot_oauth_state=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0; Secure",
    );
  });

  it("rejects malformed GitHub App setup callbacks", async () => {
    const response = await fetchWorker(
      "https://example.test/github/setup?installation_id=not-a-number&setup_action=install",
      {
        redirect: "manual",
      },
    );

    expect(response.status).toBe(400);
    expect(responseSetCookies(response)).toContain(
      "__Host-cyspbot_oauth_state=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0; Secure",
    );
  });

  it("authorizes the dashboard with GitHub user auth and renders recent repository token requests", async () => {
    const firstMint = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(firstMint.status).toBe(200);

    const secondMint = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        actor: "octocat",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(secondMint.status).toBe(200);

    const dashboardRedirect = await fetchWorker("https://example.test/dashboard", {
      redirect: "manual",
    });
    expect(dashboardRedirect.status).toBe(302);
    expect(dashboardRedirect.headers.get("location")).toBe("/login/github?return_to=%2Fdashboard");

    const loginResponse = await fetchWorker("https://example.test/login/github", {
      redirect: "manual",
    });
    expect(loginResponse.status).toBe(302);
    const stateCookie = responseSetCookies(loginResponse)[0];
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("__Host-cyspbot_oauth_state=");
    const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://example.test");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).not.toBeNull();

    const callbackResponse = await fetchWorker(
      `https://example.test/auth/github/callback?code=test-dashboard-code&state=${encodeURIComponent(state ?? "")}`,
      {
        headers: {
          cookie: cookieHeaderValue(stateCookie!),
        },
        redirect: "manual",
      },
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe("/dashboard");
    const sessionCookie = responseSetCookies(callbackResponse).find((cookie) =>
      cookie.startsWith("__Host-cyspbot_dashboard_session="),
    );
    expect(sessionCookie).toBeDefined();

    const dashboardResponse = await fetchWorker("https://example.test/dashboard", {
      headers: {
        cookie: cookieHeaderValue(sessionCookie!),
      },
    });
    expect(dashboardResponse.status).toBe(200);
    const dashboardHtml = await dashboardResponse.text();
    expect(dashboardHtml).toContain("cysp/terraform-provider-contentful");
    expect(dashboardHtml).toContain("Repository audit");

    const repositoryResponse = await fetchWorker(
      "https://example.test/dashboard/repositories/cysp/terraform-provider-contentful",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie!),
        },
      },
    );
    expect(repositoryResponse.status).toBe(200);
    const repositoryHtml = await repositoryResponse.text();
    expect(repositoryHtml).toContain("Last 5 issuance attempts");
    expect(repositoryHtml).toContain("issued");
    expect(repositoryHtml).toContain("octocat");

    await workerEnv.DB.prepare(
      `
        UPDATE dashboard_users
        SET session_revoked_after = ?
        WHERE github_user_id = ?
      `,
    )
      .bind("2026-05-24T00:00:01.000Z", "42")
      .run();

    const revokedSessionResponse = await fetchWorker("https://example.test/dashboard", {
      headers: {
        cookie: cookieHeaderValue(sessionCookie!),
      },
      redirect: "manual",
    });

    expect(revokedSessionResponse.status).toBe(302);
    expect(revokedSessionResponse.headers.get("location")).toBe(
      "/login/github?return_to=%2Fdashboard",
    );
    expect(responseSetCookies(revokedSessionResponse)).toContain(
      "__Host-cyspbot_dashboard_session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0; Secure",
    );
  });
});
