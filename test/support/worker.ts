import { createPrivateKey } from "node:crypto";

import d1SchemaSql from "../../migrations/0001_dashboard_d1_recut.sql?raw";
import pullRequestHaikuSchemaSql from "../../migrations/0004_pull_request_haiku.sql?raw";
import pullRequestHaikuOptInAttributionSql from "../../migrations/0006_drop_pull_request_haiku_opt_in_attribution.sql?raw";
import type { OidcIssuerVerifierObject } from "../../src/durable-objects/oidc-issuer-verifier-object.ts";
import type { Env } from "../../src/env.ts";
import { loadIssuerRegistrationByIssuer } from "../../src/oidc/issuer-registrations.ts";
import type { VerifyOidcTokenResult } from "../../src/oidc/principals.ts";
import { pullRequestHaikuFeatureEnabled } from "../../src/pull-request-haiku/feature-flag.ts";
import type { PullRequestHaikuQueueMessage } from "../../src/pull-request-haiku/queue.ts";
import {
  pullRequestHaikuRepositoryOptedIn,
  recordPullRequestHaikuQueued,
} from "../../src/storage/pull-request-haiku.ts";
import { authenticateOidcToken, authenticateRequest } from "../../src/worker/authentication.ts";
import { createApp } from "../../src/worker/app.ts";
import type { AppDependencies } from "../../src/worker/dependencies.ts";
import { env } from "cloudflare:workers";
import { decodeJwt, SignJWT } from "jose";

export const workerEnv = env as unknown as Env;

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
export const testEnv: Env = {
  ...workerEnv,
  DASHBOARD_SESSION_LOOKUP_SECRET: "test-dashboard-session-lookup-secret",
  DASHBOARD_TOKEN_ENCRYPTION_SECRET: "test-dashboard-token-encryption-secret",
  GITHUB_API_BASE_URL: "https://example.test/__test/github",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_CLIENT_ID: "Iv1.testclientid",
  GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  GITHUB_APP_PRIVATE_KEY: undefined,
  GITHUB_APP_PRIVATE_KEY_PEM: testPrivateKeyPem,
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  OIDC_ISSUER_VERIFIER: fakeOidcIssuerVerifierNamespace(),
  PULL_REQUEST_HAIKU_TEXT_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8",
};
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
export const githubInstallationAccessTokenType =
  "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const testRepository = "cysp/terraform-provider-contentful";
const testRepositoryId = "123456789";
const testInstallationId = 67890;
const testRepositoryOwnerId = "555555";
const testRepositoryVisibility = "private";
const testDashboardAccessToken = "ghu_test_token";
const testDashboardRefreshToken = "ghr_test_token";
const testNow = new Date("2026-05-24T00:00:00.000Z");
export const enqueuedPullRequestHaikuMessages: PullRequestHaikuQueueMessage[] = [];

const baseTestDependencies = {
  authenticateOidcToken,
  authenticateRequest,
  enqueuePullRequestHaikuMessage: async (_env, message) => {
    enqueuedPullRequestHaikuMessages.push(message);
  },
  fetch: fetchGitHubTestDouble,
  now: () => testNow,
  pullRequestHaikuFeatureEnabled,
  pullRequestHaikuRepositoryOptedIn,
  processPullRequestHaikuMessage: async (env, message) => {
    const { processPullRequestHaikuMessage } =
      await import("../../src/pull-request-haiku/processor.ts");

    await processPullRequestHaikuMessage(env, message, {
      generatePullRequestHaiku: async () => ({
        costEstimate: {
          cachedInputTokens: null,
          estimatedCostUsd: 0.0000577,
          estimatedNeurons: 5.2345,
          inputTokens: 1000,
          inputUsdPerMillionTokens: 0.051,
          model: "@cf/qwen/qwen3-30b-a3b-fp8",
          outputTokens: 20,
          outputUsdPerMillionTokens: 0.335,
          scope: "prompt",
          totalTokens: 1020,
        },
        haiku: {
          items: [
            {
              style: "haiku",
              text: "Queue winds softly\nComments bloom on branch changes\nReview dawns again",
            },
          ],
        },
        model: "@cf/qwen/qwen3-30b-a3b-fp8",
      }),
      fetch: fetchGitHubTestDouble,
      now: () => testNow,
    });
  },
  reconcileInstallation: (env, installationId) =>
    env.GITHUB_INSTALLATION.getByName(String(installationId)).signalInstallationReconciliation({
      installationId,
      signalSource: "webhook",
    }),
  recordPullRequestHaikuQueued,
} satisfies AppDependencies;

export const testApp = createApp(baseTestDependencies);

export const dashboardAccessForbiddenApp = createApp({
  ...baseTestDependencies,
  fetch: fetchGitHubDashboardAccessForbiddenTestDouble,
  processPullRequestHaikuMessage: async () => undefined,
});

export const dashboardLaterInstallationFailsApp = createApp({
  ...baseTestDependencies,
  fetch: fetchGitHubDashboardLaterInstallationFailsTestDouble,
  processPullRequestHaikuMessage: async () => undefined,
});

export const dashboardRepositoryAdminDeniedApp = createApp({
  ...baseTestDependencies,
  fetch: fetchGitHubDashboardRepositoryAdminDeniedTestDouble,
  processPullRequestHaikuMessage: async () => undefined,
});

export async function migrateTestDatabase(): Promise<void> {
  for (const statement of `${d1SchemaSql}
${pullRequestHaikuSchemaSql}
${pullRequestHaikuOptInAttributionSql}`.split(/;\s*(?:\n|$)/u)) {
    if (statement.trim().length > 0) {
      await workerEnv.DB.prepare(statement).run();
    }
  }
}

export function fetchWorker(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetchWorkerWithApp(testApp, input, init);
}

export function fetchWorkerWithApp(
  app: ReturnType<typeof createApp>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const handler = app.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(
      new Request(input, init) as Parameters<typeof handler>[0],
      testEnv,
      {} as ExecutionContext,
    ),
  );
}

export function authorizationHeaders(
  overrides?: Partial<Record<string, string>>,
): Promise<Record<string, string>> {
  return createOidcToken(overrides).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

export async function tokenExchangeRequestBody(
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

export function cookieHeaderValue(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

export function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = response.headers.get("set-cookie");

  return combined === null ? [] : combined.split(/,(?=\s*[A-Za-z0-9_]+=)/u);
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

  const apiPath = gitHubApiPathForTestDouble(request);

  if (apiPath === null) {
    return new Response(null, { status: 404 });
  }

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
      if (
        Object.keys(requestedPermissions).length === 3 &&
        requestedPermissions["issues"] === "write" &&
        requestedPermissions["metadata"] === "read" &&
        requestedPermissions["pull_requests"] === "write"
      ) {
        return Response.json(
          {
            expires_at: "2030-01-01T00:00:00Z",
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            token: "ghs_test_pr_ai_token",
          },
          { status: 201 },
        );
      }

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

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/pulls/12`) {
    return Response.json({
      additions: 120,
      base: { ref: "main" },
      body: "Adds the first pull request haiku comment.",
      changed_files: 3,
      deletions: 30,
      draft: false,
      head: { ref: "feature/pr-haiku", sha: "abc123def456abc123def456abc123def456abcd" },
      html_url: "https://github.com/cysp/terraform-provider-contentful/pull/12",
      number: 12,
      title: "Add pull request haiku comments",
      user: { login: "sally" },
    });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/pulls/12/files`) {
    return Response.json([
      {
        additions: 80,
        changes: 90,
        deletions: 10,
        filename: "src/worker/app.ts",
        patch:
          "@@ -1,3 +1,4 @@\n import { createApp } from './app';\n+import { queueHaiku } from './haiku';",
        status: "modified",
      },
      {
        additions: 30,
        changes: 40,
        deletions: 10,
        filename: "migrations/0004_pull_request_haiku.sql",
        patch: "@@ -1,3 +1,4 @@\n CREATE TABLE pull_request_haiku_runs (\n+  output_kind TEXT",
        status: "added",
      },
      {
        additions: 10,
        changes: 20,
        deletions: 10,
        filename: "test/worker.test.ts",
        patch:
          "@@ -1,3 +1,4 @@\n describe('worker', () => {\n+  it('writes haiku comments', async () => {})",
        status: "modified",
      },
    ]);
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/issues/12/comments`) {
    return Response.json([]);
  }

  if (request.method === "POST" && apiPath === `/repos/${testRepository}/issues/12/comments`) {
    const body = (await request.json()) as Record<string, unknown>;

    if (
      typeof body["body"] !== "string" ||
      !body["body"].includes("cyspbot:pull-request-haiku") ||
      !body["body"].includes("cyspbot:pull-request-haiku-cost") ||
      !body["body"].includes('"estimatedCostUsd":0.0000577') ||
      !body["body"].includes('<p align="center">') ||
      !body["body"].includes("<em>Queue winds softly<br>") ||
      !body["body"].includes("Comments bloom on branch changes<br>") ||
      !body["body"].includes("Review dawns again</em>")
    ) {
      return new Response(null, { status: 500 });
    }

    return Response.json(
      {
        body: body["body"],
        id: 987654,
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

async function fetchGitHubDashboardAccessForbiddenTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const apiPath = gitHubApiPathForTestDouble(request);

  if (request.method === "GET" && apiPath === "/user/installations") {
    return new Response(null, { status: 403 });
  }

  return fetchGitHubTestDouble(request);
}

async function fetchGitHubDashboardLaterInstallationFailsTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const apiPath = gitHubApiPathForTestDouble(request);
  const laterInstallationId = testInstallationId + 1;

  if (request.method === "GET" && apiPath === "/user/installations") {
    return Response.json({
      installations: [{ id: testInstallationId }, { id: laterInstallationId }],
    });
  }

  if (
    request.method === "GET" &&
    apiPath === `/user/installations/${laterInstallationId}/repositories`
  ) {
    return new Response(null, { status: 500 });
  }

  return fetchGitHubTestDouble(request);
}

async function fetchGitHubDashboardRepositoryAdminDeniedTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const apiPath = gitHubApiPathForTestDouble(request);

  if (
    request.method === "GET" &&
    apiPath === `/user/installations/${testInstallationId}/repositories`
  ) {
    return Response.json({
      repositories: [
        {
          full_name: testRepository,
          id: Number.parseInt(testRepositoryId, 10),
          permissions: {
            admin: false,
            pull: true,
            push: true,
          },
          private: true,
        },
      ],
    });
  }

  return fetchGitHubTestDouble(request);
}

function gitHubApiPathForTestDouble(request: Request): string | null {
  const url = new URL(request.url);

  if (url.hostname !== "example.test" && url.hostname !== "api.github.com") {
    return null;
  }

  return url.pathname.replace(/^\/__test\/github/u, "");
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

function fakeOidcIssuerVerifierNamespace(): DurableObjectNamespace<OidcIssuerVerifierObject> {
  return {
    getByName() {
      return {
        verifyOidcToken: verifyTestOidcToken,
      };
    },
  } as unknown as DurableObjectNamespace<OidcIssuerVerifierObject>;
}

async function verifyTestOidcToken(token: string, issuer: string): Promise<VerifyOidcTokenResult> {
  const registration = loadIssuerRegistrationByIssuer(testEnv, issuer);

  if (registration === null) {
    return {
      issuer,
      ok: false,
      reason: "configuration_error",
    };
  }

  const payload = decodeJwt(token);
  const claims: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    claims[key] = value;
  }

  const principal = registration.mapPrincipal(claims);

  if (principal === null) {
    return {
      issuer,
      ok: false,
      reason: "invalid_claims",
    };
  }

  return {
    issuer,
    ok: true,
    principal,
    resolvedKeyId: "test-key-1",
  };
}
