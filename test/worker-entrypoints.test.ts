import githubWebhookReceiverWorker from "@cyspbot/github-webhook-receiver";
import tokenExchangeWorker from "@cyspbot/token-exchange";
import { describe, expect, it, vi } from "vitest";

import rootHarness from "./support/root-test-harness.ts";

describe("worker entrypoint shapes", () => {
  it("keeps token exchange and webhook receiver as separate fetch workers", () => {
    expect(tokenExchangeWorker.fetch).toEqual(expect.any(Function));
    expect(tokenExchangeWorker.queue).toBeUndefined();

    expect(githubWebhookReceiverWorker.fetch).toEqual(expect.any(Function));
    expect(githubWebhookReceiverWorker.queue).toBeUndefined();
  });

  it("does not route product endpoints through the root test harness", async () => {
    const response = await Promise.resolve(
      rootHarness.fetch(new Request("https://example.test/token"), {}, {} as ExecutionContext),
    );

    expect(response.status).toBe(404);
  });

  it("uses the default webhook clock when configuration is missing", async () => {
    const now = new Date("2030-01-02T03:04:05.000Z");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(now);

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
          GITHUB_WEBHOOK_SECRET: "",
        },
        {} as ExecutionContext,
      );

      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledWith("webhook_receiver_not_configured", {
        occurred_at: now.toISOString(),
      });
      await response.body?.cancel();
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });
});
