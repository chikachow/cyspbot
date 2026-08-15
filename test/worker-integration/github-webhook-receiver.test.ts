import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { githubWebhookHeaders, githubWebhookTestSecret } from "../support/webhook.ts";

describe("GitHub webhook receiver Worker entrypoint", () => {
  it("classifies and enqueues a matching status comment", async () => {
    const body = JSON.stringify({
      action: "created",
      comment: {
        body: "/cyspbot status",
        id: 42,
      },
      repository: {
        name: "cyspbot",
        owner: {
          login: "chikachow",
        },
      },
    });
    const response = await exports.default.fetch("https://example.test/github/webhooks", {
      body,
      headers: githubWebhookHeaders(
        body,
        githubWebhookTestSecret,
        "issue_comment",
        "integration-status-delivery",
        env.GITHUB_APP_ID,
      ),
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
    });
  });

  it("accepts a signed ping for the configured GitHub App", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });
    const response = await exports.default.fetch("https://example.test/github/webhooks", {
      body,
      headers: githubWebhookHeaders(
        body,
        githubWebhookTestSecret,
        "ping",
        "integration-delivery",
        env.GITHUB_APP_ID,
      ),
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      event: "ping",
    });
  });

  it("does not serve unrelated routes", async () => {
    const response = await exports.default.fetch("https://example.test/health");

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});
