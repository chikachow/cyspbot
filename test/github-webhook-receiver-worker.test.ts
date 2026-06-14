import { describe, expect, it } from "vitest";

import { fetchGitHubWebhookReceiver } from "./support/worker.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";

describe("cyspbot-github-webhook-receiver", () => {
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
