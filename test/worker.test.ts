import { beforeAll, describe, expect, it } from "vitest";

import {
  authorizationHeaders,
  cookieHeaderValue,
  createDashboardSessionCookie,
  dashboardAccessForbiddenApp,
  dashboardLaterInstallationFailsApp,
  fetchWorker,
  fetchWorkerWithApp,
  githubInstallationAccessTokenType,
  githubWebhookHeaders,
  migrateTestDatabase,
  responseSetCookies,
  tokenExchangeRequestBody,
  workerEnv,
} from "./support/worker.ts";

describe("cyspbot worker", () => {
  beforeAll(async () => {
    await migrateTestDatabase();
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

  it("verifies caller claims without evaluating the full Token Policy", async () => {
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

  it("clears the dashboard session when GitHub denies repository access refresh", async () => {
    const sessionCookie = await createDashboardSessionCookie();

    const response = await fetchWorkerWithApp(
      dashboardAccessForbiddenApp,
      "https://example.test/dashboard",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie),
        },
        redirect: "manual",
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login/github?return_to=%2Fdashboard");
    expect(responseSetCookies(response)).toContain(
      "__Host-cyspbot_dashboard_session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0; Secure",
    );
  });

  it("short-circuits dashboard repository details after the requested repository is visible", async () => {
    const sessionCookie = await createDashboardSessionCookie();

    const response = await fetchWorkerWithApp(
      dashboardLaterInstallationFailsApp,
      "https://example.test/dashboard/repositories/cysp/terraform-provider-contentful",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Last 5 issuance attempts");
  });

  it("authorizes the dashboard with GitHub user auth and renders recent Installation Token Issuance attempts", async () => {
    const firstIssuance = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(firstIssuance.status).toBe(200);

    const secondIssuance = await fetchWorker("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        actor: "octocat",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    expect(secondIssuance.status).toBe(200);

    const dashboardRedirect = await fetchWorker("https://example.test/dashboard", {
      redirect: "manual",
    });
    expect(dashboardRedirect.status).toBe(302);
    expect(dashboardRedirect.headers.get("location")).toBe("/login/github?return_to=%2Fdashboard");

    const sessionCookie = await createDashboardSessionCookie();

    const dashboardResponse = await fetchWorker("https://example.test/dashboard", {
      headers: {
        cookie: cookieHeaderValue(sessionCookie),
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
          cookie: cookieHeaderValue(sessionCookie),
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
        cookie: cookieHeaderValue(sessionCookie),
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
