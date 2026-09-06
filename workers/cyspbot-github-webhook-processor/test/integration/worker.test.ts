import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "@cyspbot/github-webhook-processor";

describe("GitHub webhook processor Worker entrypoint", () => {
  it.each([
    [42, "created", false],
    [43, "already exists", false],
    [44, "unavailable", true],
  ] as const)(
    "observes queue completion when reaction %s is %s",
    async (commentId, _name, retry) => {
      const batch = createMessageBatch("cyspbot-github-webhook-jobs", [
        {
          id: "integration-job",
          attempts: 1,
          timestamp: new Date("2026-08-15T00:00:00.000Z"),
          body: {
            commentId,
            deliveryId: "integration-delivery",
            kind: "github.issue-comment.status-reaction",
            repository: { name: "cyspbot", owner: "chikachow" },
            version: 1,
          },
        },
      ]);
      const context = createExecutionContext();
      if (worker.queue === undefined) throw new Error("expected a queue handler");
      await worker.queue(batch, env, context);
      const result = await getQueueResult(batch, context);
      expect(result.explicitAcks).toEqual(retry ? [] : ["integration-job"]);
      expect(result.retryMessages).toEqual(retry ? [{ msgId: "integration-job" }] : []);
      expect(result.ackAll).toBe(false);
      expect(result.retryBatch).toMatchObject({ retry: false });
    },
  );
});
