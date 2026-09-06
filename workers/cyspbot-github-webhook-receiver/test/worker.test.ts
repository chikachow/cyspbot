import githubWebhookReceiverWorker from "@cyspbot/github-webhook-receiver";
import { describe, expect, it, vi } from "vitest";

import { fetchGitHubWebhookReceiver } from "./support/worker.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";

describe("cyspbot-github-webhook-receiver", () => {
  it.each(["x-github-event", "x-github-delivery", "x-hub-signature-256"])(
    "rejects a missing %s header",
    async (header) => {
      const body = "{}";
      const headers = new Headers(githubWebhookHeaders(body, "test-webhook-secret"));
      headers.delete(header);
      const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
      });
    },
  );

  it("requires a JSON media type even when the body authenticates", async () => {
    const body = "{}";
    const headers = new Headers(githubWebhookHeaders(body, "test-webhook-secret"));
    headers.delete("content-type");
    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body: new TextEncoder().encode(body),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unsupported Media Type",
      status: 415,
    });
  });

  it.each(["GET", "PUT", "DELETE", "OPTIONS"])(
    "rejects %s before webhook authentication",
    async (method) => {
      const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
        method,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      await expect(response.json()).resolves.toEqual({
        type: "about:blank",
        title: "Method Not Allowed",
        status: 405,
      });
    },
  );

  it("rejects webhook payloads with an invalid signature", async () => {
    const body = JSON.stringify({
      action: "added",
      repositories_added: [],
      repositories_removed: [],
    });
    const headers = githubWebhookHeaders(body, "wrong-secret");

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
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
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret"),
      "x-github-hook-installation-target-id": "999999",
    };

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  it("accepts signed github ping webhook deliveries", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret", "ping");

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
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
      installation: {
        id: 67890,
      },
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret"),
      "content-type": "text/plain",
    };

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(415);
  });

  it("rejects webhook payloads larger than 256 KiB", async () => {
    const body = JSON.stringify({
      payload: "x".repeat(256 * 1024),
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret");

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(413);
  });

  it("rejects signed webhook deliveries with invalid JSON", async () => {
    const body = "{";
    const headers = githubWebhookHeaders(body, "test-webhook-secret", "issues");

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(400);
  });

  it("acknowledges signed non-ping webhook deliveries without event-specific parsing", async () => {
    const body = JSON.stringify({
      action: "synchronize",
      pull_request: {
        head: {},
      },
    });
    const headers = githubWebhookHeaders(body, "test-webhook-secret", "pull_request");

    const response = await fetchGitHubWebhookReceiver("https://example.test/github/webhooks", {
      body,
      headers,
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
    });
  });
});

describe("worker entrypoint shapes", () => {
  it("exports the webhook receiver as a fetch worker", () => {
    expect(githubWebhookReceiverWorker.fetch).toEqual(expect.any(Function));
    expect(githubWebhookReceiverWorker.queue).toBeUndefined();
  });

  it("returns a configuration error without logging secrets", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const fetch = githubWebhookReceiverWorker.fetch;

      if (fetch === undefined) {
        throw new Error("expected webhook receiver fetch handler");
      }

      const response = await fetch(
        new Request("https://example.test/github/webhooks", {
          method: "POST",
        }) as Parameters<typeof fetch>[0],
        {
          GITHUB_APP_ID: "000000",
          GITHUB_WEBHOOK_JOBS: {
            metrics: async () => ({
              backlogBytes: 0,
              backlogCount: 0,
            }),
            send: async () => ({
              metadata: {
                metrics: {
                  backlogBytes: 0,
                  backlogCount: 0,
                },
              },
            }),
            sendBatch: async () => ({
              metadata: {
                metrics: {
                  backlogBytes: 0,
                  backlogCount: 0,
                },
              },
            }),
          },
          GITHUB_WEBHOOK_SECRET: "",
        },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledWith("webhook_receiver_not_configured");
      await response.body?.cancel();
    } finally {
      consoleError.mockRestore();
    }
  });
});
