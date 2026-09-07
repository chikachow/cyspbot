import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "wrangler";

import { githubWebhookProcessorOutboundService } from "../../workers/cyspbot-github-webhook-processor/test/integration/outbound.ts";
import {
  githubWebhookHeaders,
  githubWebhookTestSecret,
} from "../../workers/cyspbot-github-webhook-receiver/test/support/webhook.ts";

describe("built Workers", () => {
  const server = createTestHarness({
    workers: [
      { configPath: "workers/cyspbot/wrangler.jsonc" },
      {
        configPath: "workers/cyspbot-github-webhook-receiver/wrangler.jsonc",
        secrets: { GITHUB_WEBHOOK_SECRET: githubWebhookTestSecret },
      },
      { configPath: "workers/cyspbot-github-webhook-processor/wrangler.jsonc" },
      {
        config: {
          name: "github-app-token-broker-local",
          main: "test/integration/token-broker.ts",
          compatibility_date: "2026-07-24",
        },
      },
      {
        config: {
          name: "workload-identity-issuer-local",
          main: "workers/cyspbot-github-webhook-processor/test/integration/workload-identity-issuer.mjs",
          compatibility_date: "2026-07-24",
        },
      },
    ],
  });
  const outbound = vi.fn<typeof fetch>(async (input, init) =>
    githubWebhookProcessorOutboundService(new Request(input, init)),
  );

  beforeAll(async () => {
    vi.stubGlobal("fetch", outbound);
    await server.listen();
  }, 30_000);

  afterEach(({ task }) => {
    if (task.result?.state === "fail") server.debug();
    outbound.mockClear();
  });

  afterAll(async () => {
    try {
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves the root page from the built entrypoint", async () => {
    const response = await server.fetch("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("beep, boop. i am a bot.");
  });

  it.each([
    ["HEAD", "/", 200, null],
    ["POST", "/", 405, "GET, HEAD"],
    ["GET", "/absent", 404, null],
  ] as const)("handles %s %s at the built entrypoint", async (method, path, status, allow) => {
    const response = await server.fetch(path, { method });

    expect(response.status).toBe(status);
    expect(response.headers.get("allow")).toBe(allow);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["invalid signature", "incorrect-secret", "000000"],
    ["incorrect installation target", githubWebhookTestSecret, "999999"],
  ] as const)("rejects a matching webhook with %s", async (_name, secret, targetId) => {
    const body = JSON.stringify({
      action: "created",
      comment: { body: "/cyspbot status", id: 42 },
      repository: { name: "cyspbot", owner: { login: "chikachow" } },
    });
    const receiver = server.getWorker("cyspbot-github-webhook-receiver");
    const response = await receiver.fetch("https://example.test/github/webhooks", {
      body,
      headers: githubWebhookHeaders(
        body,
        secret,
        "issue_comment",
        "built-workers-delivery",
        targetId,
      ),
      method: "POST",
    });

    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it.each([
    [42, "created", 201],
    [43, "already exists", 200],
  ] as const)(
    "delivers a signed webhook through the queue when reaction %s is %s",
    async (commentId, _name, status) => {
      const body = JSON.stringify({
        action: "created",
        comment: { body: "/cyspbot status", id: commentId },
        repository: { name: "cyspbot", owner: { login: "chikachow" } },
      });
      const receiver = server.getWorker("cyspbot-github-webhook-receiver");
      const response = await receiver.fetch("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(
          body,
          githubWebhookTestSecret,
          "issue_comment",
          `built-workers-delivery-${commentId}`,
        ),
        method: "POST",
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      await expect.poll(() => outbound.mock.calls.length, { timeout: 5_000 }).toBe(1);
      await expect(outbound.mock.results[0]?.value).resolves.toMatchObject({ status });
    },
    10_000,
  );
});
