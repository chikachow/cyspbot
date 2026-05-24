import { createHmac, createPrivateKey } from "node:crypto";

import type { Env } from "../src/env.ts";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

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
  it("returns minimal problem details for missing authentication", async () => {
    const response = await SELF.fetch("https://example.test/github/claims", {
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
    const response = await SELF.fetch("https://example.test/github/claims", {
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
    const response = await SELF.fetch("https://example.test/github/claims", {
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

  it("mints a repository-scoped installation token for allowed events", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expires_at: "2030-01-01T00:00:00Z",
      token: "ghs_test_token",
    });
  });

  it("exchanges a github actions oidc token at the sts endpoint", async () => {
    const response = await SELF.fetch("https://example.test/token", {
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
    const response = await SELF.fetch("https://example.test/token", {
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
    const response = await SELF.fetch("https://example.test/token", {
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
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "pull_request",
        ref: "refs/pull/15/merge",
      }),
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      status: 403,
      title: "Forbidden",
      type: "about:blank",
    });
  });

  it("maps disallowed token exchange contexts to oauth token errors", async () => {
    const response = await SELF.fetch("https://example.test/token", {
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
    const response = await SELF.fetch("https://example.test/token", {
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
    const response = await SELF.fetch("https://example.test/token", {
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

  it("rejects pushes that are not on the current default branch", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "push",
        ref: "refs/heads/feature-branch",
      }),
      method: "POST",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      status: 403,
      title: "Forbidden",
      type: "about:blank",
    });
  });

  it("allows pushes on the current default branch", async () => {
    const response = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        event_name: "push",
        ref: "refs/heads/main",
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      expires_at: "2030-01-01T00:00:00Z",
      token: "ghs_test_token",
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

    const response = await SELF.fetch("https://example.test/github/webhooks", {
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

    const response = await SELF.fetch("https://example.test/github/webhooks", {
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

    const response = await SELF.fetch("https://example.test/github/webhooks", {
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

    const response = await SELF.fetch("https://example.test/github/webhooks", {
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

    const response = await SELF.fetch("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
    });
  });

  it("runs maintenance migration for existing durable object ids", async () => {
    const durableObjectId = workerEnv.GITHUB_INSTALLATION.idFromName("67890");
    const installationStub = workerEnv.GITHUB_INSTALLATION.getByName("67890");
    await installationStub.runMigrations();

    const response = await SELF.fetch(
      "https://example.test/internal/durable-objects/github-installations/migrate",
      {
        body: JSON.stringify({
          object_ids: [durableObjectId.toString()],
        }),
        headers: {
          authorization: "Bearer test-maintenance-token",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      migrated: true,
      object_ids: [durableObjectId.toString()],
    });
  });

  it("authorizes the dashboard with GitHub user auth and renders recent repository token requests", async () => {
    const firstMint = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders(),
      method: "POST",
    });
    expect(firstMint.status).toBe(200);

    const secondMint = await SELF.fetch("https://example.test/github/installations/token", {
      headers: await authorizationHeaders({
        actor: "octocat",
      }),
      method: "POST",
    });
    expect(secondMint.status).toBe(200);

    const dashboardRedirect = await SELF.fetch("https://example.test/dashboard", {
      redirect: "manual",
    });
    expect(dashboardRedirect.status).toBe(302);
    expect(dashboardRedirect.headers.get("location")).toBe(
      "/dashboard/login/github?return_to=%2Fdashboard",
    );

    const loginResponse = await SELF.fetch("https://example.test/dashboard/login/github", {
      redirect: "manual",
    });
    expect(loginResponse.status).toBe(302);
    const stateCookie = responseSetCookies(loginResponse)[0];
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain("cyspbot_dashboard_state=");
    const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://example.test");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).not.toBeNull();

    const callbackResponse = await SELF.fetch(
      `https://example.test/dashboard/auth/github/callback?code=test-dashboard-code&state=${encodeURIComponent(state ?? "")}`,
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
      cookie.startsWith("cyspbot_dashboard_session="),
    );
    expect(sessionCookie).toBeDefined();

    const dashboardResponse = await SELF.fetch("https://example.test/dashboard", {
      headers: {
        cookie: cookieHeaderValue(sessionCookie!),
      },
    });
    expect(dashboardResponse.status).toBe(200);
    const dashboardHtml = await dashboardResponse.text();
    expect(dashboardHtml).toContain("cysp/terraform-provider-contentful");
    expect(dashboardHtml).toContain("Repository audit access");

    const repositoryResponse = await SELF.fetch(
      "https://example.test/dashboard/repositories/123456789",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie!),
        },
      },
    );
    expect(repositoryResponse.status).toBe(200);
    const repositoryHtml = await repositoryResponse.text();
    expect(repositoryHtml).toContain("Last 5 token requests");
    expect(repositoryHtml).toContain("issued");
    expect(repositoryHtml).toContain("octocat");
  });
});
