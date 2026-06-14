import { describe, expect, it } from "vitest";

import {
  acceptGitHubWebhookDelivery,
  type GitHubWebhookReceiverDependencies,
} from "@cyspbot/github-webhook-receiver/github-webhooks/acceptance";
import { githubWebhookHeaders } from "./support/webhook.ts";

interface TestWebhookEnv {
  GITHUB_APP_ID: string;
  GITHUB_WEBHOOK_SECRET: string | SecretsStoreSecret;
}

const testWebhookEnv = {
  GITHUB_APP_ID: "000000",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
} satisfies TestWebhookEnv;

describe("webhook delivery acceptance", () => {
  it("acknowledges signed non-ping webhook deliveries without dispatching", async () => {
    const body = JSON.stringify({
      action: "opened",
      issue: {
        number: 12,
      },
    });

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues", "delivery-issues"),
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      body: { accepted: true },
      kind: "accepted",
      status: 202,
    });
  });

  it("accepts signed github ping webhook deliveries", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      body: { accepted: true, event: "ping" },
      kind: "accepted",
      status: 202,
    });
  });

  it("reads the webhook secret from Cloudflare Secrets Store when bound", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      {
        GITHUB_APP_ID: testWebhookEnv.GITHUB_APP_ID,
        GITHUB_WEBHOOK_SECRET: {
          get: async () => "test-webhook-secret",
        },
      },
      testDependencies(),
    );

    expect(result).toEqual({
      body: { accepted: true, event: "ping" },
      kind: "accepted",
      status: 202,
    });
  });

  it("accepts repeated signed webhook delivery ids", async () => {
    const body = JSON.stringify({
      action: "opened",
    });
    const request = () =>
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues", "delivery-repeat"),
        method: "POST",
      });

    await expect(
      acceptGitHubWebhookDelivery(request(), testWebhookEnv, testDependencies()),
    ).resolves.toMatchObject({
      kind: "accepted",
      status: 202,
    });

    await expect(
      acceptGitHubWebhookDelivery(request(), testWebhookEnv, testDependencies()),
    ).resolves.toMatchObject({
      kind: "accepted",
      status: 202,
    });
  });

  it("rejects invalid json after authenticating the delivery", async () => {
    const body = "{";

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues"),
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      kind: "rejected",
      status: 400,
    });
  });

  it("rejects invalid signatures", async () => {
    const body = JSON.stringify({
      action: "opened",
    });

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "wrong-secret", "issues"),
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      kind: "rejected",
      status: 401,
    });
  });

  it("rejects oversized streamed bodies without relying on content-length", async () => {
    const body = JSON.stringify({
      payload: "x".repeat(256 * 1024),
    });
    const request = new Request("https://example.test/github/webhooks", {
      body: new Blob([body]).stream(),
      headers: githubWebhookHeaders(body, "test-webhook-secret", "issues"),
      method: "POST",
    });

    expect(request.headers.get("content-length")).toBeNull();

    const result = await acceptGitHubWebhookDelivery(request, testWebhookEnv, testDependencies());

    expect(result).toEqual({
      kind: "rejected",
      status: 413,
    });
  });

  it.each([
    ["missing prefix", "a".repeat(64)],
    ["short digest", `sha256=${"a".repeat(63)}`],
    ["uppercase digest", `sha256=${"A".repeat(64)}`],
    ["non-hex digest", `sha256=${"g".repeat(64)}`],
  ])("rejects malformed signatures: %s", async (_name, signatureHeader) => {
    const body = JSON.stringify({
      action: "opened",
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret", "issues"),
      "x-hub-signature-256": signatureHeader,
    };

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      kind: "rejected",
      status: 401,
    });
  });

  it("rejects content types whose primary media type is not JSON", async () => {
    const body = JSON.stringify({
      action: "opened",
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret", "issues"),
      "content-type": "text/plain; application/json",
    };

    const result = await acceptGitHubWebhookDelivery(
      new Request("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      }),
      testWebhookEnv,
      testDependencies(),
    );

    expect(result).toEqual({
      kind: "rejected",
      status: 415,
    });
  });
});

function testDependencies(): GitHubWebhookReceiverDependencies {
  return {
    now: () => new Date("2026-05-24T00:00:00.000Z"),
  };
}
