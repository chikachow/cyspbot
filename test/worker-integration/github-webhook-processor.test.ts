import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GitHub webhook processor Worker entrypoint", () => {
  it("processes a status reaction through the real queue entrypoint", async () => {
    const processor = exports.default as ProcessorEntrypoint;
    const queue = processor.queue;
    if (queue === undefined) {
      throw new Error("expected a queue handler");
    }

    await expect(
      queue(
        {
          messages: [
            {
              ack() {},
              attempts: 1,
              body: {
                commentId: 42,
                deliveryId: "integration-delivery",
                kind: "github.issue-comment.status-reaction",
                repository: {
                  name: "cyspbot",
                  owner: "chikachow",
                },
                version: 1,
              },
              id: "valid-job",
              retry() {},
              timestamp: new Date("2026-08-15T00:00:00.000Z"),
            },
          ],
          metadata: {
            metrics: {
              backlogBytes: 0,
              backlogCount: 0,
            },
          },
          queue: "cyspbot-github-webhook-jobs",
          ackAll() {},
          retryAll() {},
        },
        env,
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });
});

type ProcessorEntrypoint = Pick<
  ExportedHandler<GitHubWebhookProcessorEnv, unknown>,
  "fetch" | "queue"
>;
