import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authorizationHeaders,
  cookieHeaderValue,
  dashboardAccessForbiddenApp,
  dashboardLaterInstallationFailsApp,
  dashboardRepositoryAdminDeniedApp,
  enqueuedPullRequestHaikuMessages,
  fetchWorker,
  fetchWorkerWithApp,
  githubInstallationAccessTokenType,
  migrateTestDatabase,
  responseSetCookies,
  testEnv,
  testApp,
  tokenExchangeRequestBody,
  workerEnv,
} from "./support/worker.ts";
import { createDashboardSessionCookie } from "./support/dashboard.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";

describe("cyspbot worker", () => {
  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    enqueuedPullRequestHaikuMessages.length = 0;
    testEnv.FLAGS = undefined;
    await workerEnv.DB.prepare("DELETE FROM pull_request_haiku_runs").run();
    await workerEnv.DB.prepare("DELETE FROM pull_request_haiku_comments").run();
    await workerEnv.DB.prepare("DELETE FROM pull_request_haiku_repository_opt_ins").run();
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

  it("rejects signed webhook payloads for a different github app", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: {
        id: 67890,
      },
      repositories_added: [],
      repositories_removed: [],
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret"),
      "x-github-hook-installation-target-id": "999999",
    };

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

  it("does not enqueue pull request haiku comments until the repository is opted in", async () => {
    const body = JSON.stringify({
      action: "synchronize",
      installation: {
        id: 67890,
      },
      pull_request: {
        head: {
          sha: "abc123def456abc123def456abc123def456abcd",
        },
        number: 12,
      },
      repository: {
        full_name: "cysp/terraform-provider-contentful",
        id: 123456789,
      },
    });
    const headers = githubWebhookHeaders(
      body,
      "test-webhook-secret",
      "pull_request",
      "delivery-pr-not-opted-in",
    );

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(enqueuedPullRequestHaikuMessages).toHaveLength(0);
  });

  it("does not enqueue pull request haiku comments when the feature flag is disabled", async () => {
    await workerEnv.DB.prepare(
      `
        INSERT OR REPLACE INTO pull_request_haiku_repository_opt_ins (
          repository_id,
          repository_full_name_display,
          enabled_at,
          enabled_by
        ) VALUES (?, ?, ?, ?)
      `,
    )
      .bind(123456789, "cysp/terraform-provider-contentful", "2026-05-24T00:00:00.000Z", "test")
      .run();

    const evaluations: Array<{
      context?: Record<string, string | number | boolean>;
      defaultValue: boolean;
      flagKey: string;
    }> = [];
    testEnv.FLAGS = {
      async getBooleanValue(flagKey, defaultValue, context) {
        evaluations.push({ context, defaultValue, flagKey });
        return false;
      },
    };

    const body = JSON.stringify({
      action: "synchronize",
      installation: {
        id: 67890,
      },
      pull_request: {
        head: {
          sha: "abc123def456abc123def456abc123def456abcd",
        },
        number: 12,
      },
      repository: {
        full_name: "cysp/terraform-provider-contentful",
        id: 123456789,
      },
    });
    const headers = githubWebhookHeaders(
      body,
      "test-webhook-secret",
      "pull_request",
      "delivery-pr-flag-disabled",
    );

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(enqueuedPullRequestHaikuMessages).toHaveLength(0);
    expect(evaluations).toEqual([
      {
        context: {
          installationId: 67890,
          pullRequestNumber: 12,
          repositoryFullName: "cysp/terraform-provider-contentful",
          repositoryId: 123456789,
        },
        defaultValue: true,
        flagKey: "pull-request-haiku",
      },
    ]);
  });

  it("enqueues opted-in pull request webhook deliveries for haiku comment processing", async () => {
    await workerEnv.DB.prepare(
      `
        INSERT OR REPLACE INTO pull_request_haiku_repository_opt_ins (
          repository_id,
          repository_full_name_display,
          enabled_at,
          enabled_by
        ) VALUES (?, ?, ?, ?)
      `,
    )
      .bind(123456789, "cysp/terraform-provider-contentful", "2026-05-24T00:00:00.000Z", "test")
      .run();

    const body = JSON.stringify({
      action: "synchronize",
      installation: {
        id: 67890,
      },
      pull_request: {
        head: {
          sha: "abc123def456abc123def456abc123def456abcd",
        },
        number: 12,
      },
      repository: {
        full_name: "cysp/terraform-provider-contentful",
        id: 123456789,
      },
    });
    const headers = githubWebhookHeaders(
      body,
      "test-webhook-secret",
      "pull_request",
      "delivery-pr-opted-in",
    );

    const response = await fetchWorker("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(enqueuedPullRequestHaikuMessages).toEqual([
      {
        action: "synchronize",
        deliveryId: "delivery-pr-opted-in",
        enqueuedAt: "2026-05-24T00:00:00.000Z",
        headSha: "abc123def456abc123def456abc123def456abcd",
        installationId: 67890,
        pullRequestNumber: 12,
        repositoryFullName: "cysp/terraform-provider-contentful",
        repositoryId: 123456789,
      },
    ]);
  });

  it("processes pull request haiku queue messages into one upserted PR comment", async () => {
    await workerEnv.DB.prepare(
      `
        INSERT OR REPLACE INTO pull_request_haiku_comments (
          repository_id,
          pull_request_number,
          repository_full_name_display,
          current_head_sha,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    )
      .bind(
        123456789,
        12,
        "cysp/terraform-provider-contentful",
        "abc123def456abc123def456abc123def456abcd",
        "2026-05-24T00:00:00.000Z",
      )
      .run();
    await workerEnv.DB.prepare(
      `
        INSERT OR REPLACE INTO pull_request_haiku_runs (
          delivery_id,
          repository_id,
          repository_full_name_display,
          pull_request_number,
          installation_id,
          action,
          head_sha,
          run_status,
          queued_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
    )
      .bind(
        "delivery-pr-queue",
        123456789,
        "cysp/terraform-provider-contentful",
        12,
        67890,
        "synchronize",
        "abc123def456abc123def456abc123def456abcd",
        "2026-05-24T00:00:00.000Z",
        "2026-05-24T00:00:00.000Z",
      )
      .run();

    const queueHandler = testApp.queue;

    if (queueHandler === undefined) {
      throw new Error("test app has no queue handler");
    }

    const ctx = createExecutionContext();
    const batch = createMessageBatch("cyspbot-pr-haiku-test", [
      {
        attempts: 1,
        body: {
          action: "synchronize",
          deliveryId: "delivery-pr-queue",
          enqueuedAt: "2026-05-24T00:00:00.000Z",
          headSha: "abc123def456abc123def456abc123def456abcd",
          installationId: 67890,
          pullRequestNumber: 12,
          repositoryFullName: "cysp/terraform-provider-contentful",
          repositoryId: 123456789,
        },
        id: "message-1",
        timestamp: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);

    await queueHandler(batch, testEnv, ctx);

    const queueResult = await getQueueResult(batch, ctx);
    expect(queueResult.outcome).toBe("ok");

    const row = await workerEnv.DB.prepare(
      `
        SELECT run_status, comment_id, output_kind
        FROM pull_request_haiku_runs
        WHERE delivery_id = ?
      `,
    )
      .bind("delivery-pr-queue")
      .first<{ comment_id: number; output_kind: string; run_status: string }>();

    expect(row).toEqual({
      comment_id: 987654,
      output_kind: "markdown",
      run_status: "succeeded",
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

    const haikuSettingsResponse = await fetchWorker(
      "https://example.test/dashboard/pull-request-haikus",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie),
        },
      },
    );
    expect(haikuSettingsResponse.status).toBe(200);
    const haikuSettingsHtml = await haikuSettingsResponse.text();
    expect(haikuSettingsHtml).toContain("Pull request haikus");
    expect(haikuSettingsHtml).toContain("cysp/terraform-provider-contentful");
    expect(haikuSettingsHtml).toContain("Disabled");

    const enableHaikusResponse = await fetchWorker(
      "https://example.test/dashboard/pull-request-haikus",
      {
        body: new URLSearchParams({
          action: "enable",
          repository_id: "123456789",
        }).toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookieHeaderValue(sessionCookie),
          origin: "https://example.test",
        },
        method: "POST",
        redirect: "manual",
      },
    );
    expect(enableHaikusResponse.status).toBe(302);
    expect(enableHaikusResponse.headers.get("location")).toBe("/dashboard/pull-request-haikus");

    const optInRow = await workerEnv.DB.prepare(
      `
        SELECT repository_full_name_display, enabled_by
        FROM pull_request_haiku_repository_opt_ins
        WHERE repository_id = ?
      `,
    )
      .bind(123456789)
      .first<{ enabled_by: string; repository_full_name_display: string }>();
    expect(optInRow).toEqual({
      enabled_by: "sally",
      repository_full_name_display: "cysp/terraform-provider-contentful",
    });

    const deniedHaikuSettingsResponse = await fetchWorkerWithApp(
      dashboardRepositoryAdminDeniedApp,
      "https://example.test/dashboard/pull-request-haikus",
      {
        headers: {
          cookie: cookieHeaderValue(sessionCookie),
        },
      },
    );
    expect(deniedHaikuSettingsResponse.status).toBe(403);

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
