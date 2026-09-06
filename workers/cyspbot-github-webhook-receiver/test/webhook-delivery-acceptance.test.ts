import { describe, expect, it } from "vitest";

import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { handleGitHubWebhookRequest } from "../src/webhook.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";

interface TestWebhookEnv {
  GITHUB_APP_ID: string;
  GITHUB_WEBHOOK_JOBS: {
    send(
      message: GitHubIssueCommentStatusReactionJob,
      options?: { contentType?: "json" },
    ): Promise<unknown>;
  };
  GITHUB_WEBHOOK_SECRET: string | SecretsStoreSecret;
}

const testWebhookEnv = {
  GITHUB_APP_ID: "000000",
  GITHUB_WEBHOOK_JOBS: {
    send: async () => ({}),
  },
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

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues", "delivery-issues"),
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true });
  });

  it("accepts signed github ping webhook deliveries", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true, event: "ping" });
  });

  it("enqueues a job for a newly created status comment", async () => {
    const jobs: GitHubIssueCommentStatusReactionJob[] = [];
    const body = JSON.stringify({
      action: "created",
      comment: {
        body: "  /cyspbot status  ",
        id: 42,
      },
      repository: {
        name: "cyspbot",
        owner: {
          login: "chikachow",
        },
      },
    });

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issue_comment", "delivery-job"),
        method: "POST",
      }),
      {
        ...testWebhookEnv,
        GITHUB_WEBHOOK_JOBS: {
          send: async (job) => {
            jobs.push(job);
          },
        },
      },
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true });
    expect(jobs).toEqual([
      {
        commentId: 42,
        deliveryId: "delivery-job",
        kind: "github.issue-comment.status-reaction",
        repository: {
          name: "cyspbot",
          owner: "chikachow",
        },
        version: 1,
      },
    ]);
  });

  it("returns service unavailable when the status job cannot be enqueued", async () => {
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

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issue_comment"),
        method: "POST",
      }),
      {
        ...testWebhookEnv,
        GITHUB_WEBHOOK_JOBS: {
          send: async () => {
            throw new Error("queue unavailable");
          },
        },
      },
    );

    expect(result.status).toBe(503);
  });

  it("reads the webhook secret from Cloudflare Secrets Store when bound", async () => {
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      {
        GITHUB_APP_ID: testWebhookEnv.GITHUB_APP_ID,
        GITHUB_WEBHOOK_JOBS: testWebhookEnv.GITHUB_WEBHOOK_JOBS,
        GITHUB_WEBHOOK_SECRET: {
          get: async () => "test-webhook-secret",
        },
      },
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true, event: "ping" });
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

    await expect(handleGitHubWebhookRequest(request(), testWebhookEnv)).resolves.toMatchObject({
      status: 202,
    });

    await expect(handleGitHubWebhookRequest(request(), testWebhookEnv)).resolves.toMatchObject({
      status: 202,
    });
  });

  it("rejects invalid json after authenticating the delivery", async () => {
    const body = "{";

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues"),
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(400);
  });

  it("rejects invalid signatures", async () => {
    const body = JSON.stringify({
      action: "opened",
    });

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "wrong-secret", "issues"),
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(401);
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

    const result = await handleGitHubWebhookRequest(request, testWebhookEnv);

    expect(result.status).toBe(413);
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

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(401);
  });

  it("rejects content types whose primary media type is not JSON", async () => {
    const body = JSON.stringify({
      action: "opened",
    });
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret", "issues"),
      "content-type": "text/plain; application/json",
    };

    const result = await handleGitHubWebhookRequest(
      new Request("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      }),
      testWebhookEnv,
    );

    expect(result.status).toBe(415);
  });
});
