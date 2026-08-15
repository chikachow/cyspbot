import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GitHub webhook processor Worker entrypoint", () => {
  it("runs an invalid queue job through the queue entrypoint without external calls", async () => {
    const processor = exports.default as ProcessorEntrypoint;
    const queue = processor.queue;
    if (queue === undefined) {
      throw new Error("expected a queue handler");
    }

    await queue(
      {
        messages: [
          {
            ack() {},
            attempts: 1,
            body: {
              kind: "unknown",
            },
            id: "invalid-job",
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
    );

    expect(queue).toEqual(expect.any(Function));
  });
});

type ProcessorEntrypoint = Pick<
  ExportedHandler<GitHubWebhookProcessorEnv, unknown>,
  "fetch" | "queue"
>;
