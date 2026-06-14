import githubWebhookReceiverWorker from "@cyspbot/github-webhook-receiver";
import tokenExchangeWorker from "@cyspbot/token-exchange";
import { describe, expect, it } from "vitest";

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
});
