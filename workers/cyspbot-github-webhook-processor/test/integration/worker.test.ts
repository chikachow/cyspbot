import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "@cyspbot/github-webhook-processor";

describe("GitHub webhook processor Worker entrypoint", () => {
  it.each([
    [42, "created", undefined],
    [43, "already exists", undefined],
    [44, "unavailable", { status: 503, github: {} }],
    [45, "created after a repository redirect", undefined],
    [
      46,
      "given an unparseable redirect",
      { status: 302, github: { redirectFailure: "invalid_location" } },
    ],
    [
      47,
      "stuck in a redirect loop",
      { status: 307, github: { redirectFailure: "too_many_redirects" } },
    ],
  ] as const)(
    "observes queue completion when reaction %s is %s",
    async (commentId, _name, failure) => {
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
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await worker.queue(batch, env, context);
        const result = await getQueueResult(batch, context);
        const retry = failure !== undefined;
        expect(result.explicitAcks).toEqual(retry ? [] : ["integration-job"]);
        expect(result.retryMessages).toEqual(retry ? [{ msgId: "integration-job" }] : []);
        expect(result.ackAll).toBe(false);
        expect(result.retryBatch).toMatchObject({ retry: false });
        if (failure === undefined) {
          expect(consoleWarn).not.toHaveBeenCalled();
        } else {
          // A fixture validation failure also retries, so require the intended GitHub response.
          expect(consoleWarn).toHaveBeenCalledExactlyOnceWith("github_webhook_job_retrying", {
            attempts: 1,
            deliveryId: "integration-delivery",
            error: "GitHubReactionError",
            messageId: "integration-job",
            queue: "cyspbot-github-webhook-jobs",
            ...failure,
          });
        }
      } finally {
        consoleWarn.mockRestore();
      }
    },
  );
});
