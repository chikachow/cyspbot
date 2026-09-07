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

  it("delivers a signed webhook through the queue and posts an authenticated reaction", async () => {
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
        githubWebhookTestSecret,
        "issue_comment",
        "built-workers-delivery",
      ),
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    await expect.poll(() => outbound.mock.calls.length, { timeout: 5_000 }).toBe(1);
    await expect(outbound.mock.results[0]?.value).resolves.toMatchObject({ status: 201 });
  }, 10_000);
});
