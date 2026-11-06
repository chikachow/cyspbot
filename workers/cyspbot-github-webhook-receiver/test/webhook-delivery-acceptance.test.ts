import { describe, expect, it, vi } from "vitest";

import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { fetchGitHubWebhookReceiver, type TestWebhookEnv } from "./support/worker.ts";
import { githubWebhookHeaders } from "./support/webhook.ts";

const testWebhookConfig = {
  GITHUB_APP_ID: "000000",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
} satisfies Pick<TestWebhookEnv, "GITHUB_APP_ID" | "GITHUB_WEBHOOK_SECRET">;

const statusCommentBody = JSON.stringify({
  action: "created",
  comment: { body: "/cyspbot status", id: 42 },
  repository: { name: "cyspbot", owner: { login: "chikachow" } },
});

const statusReactionJob = {
  commentId: 42,
  deliveryId: "delivery-123",
  kind: "github.issue-comment.status-reaction",
  repository: { name: "cyspbot", owner: "chikachow" },
  version: 1,
} satisfies GitHubIssueCommentStatusReactionJob;

describe("webhook delivery acceptance", () => {
  it.each([
    ["x-github-event", undefined, 400, "Bad Request"],
    ["x-github-delivery", undefined, 400, "Bad Request"],
    ["x-hub-signature-256", undefined, 400, "Bad Request"],
    ["x-github-hook-installation-target-id", "999999", 401, "Unauthorized"],
    ["x-github-hook-installation-target-type", "repository", 401, "Unauthorized"],
    ["content-type", undefined, 415, "Unsupported Media Type"],
    ["content-type", "text/plain", 415, "Unsupported Media Type"],
    ["content-type", "text/plain; application/json", 415, "Unsupported Media Type"],
  ] as const)("rejects %s=%s without publishing", async (header, value, status, title) => {
    const headers = new Headers(
      githubWebhookHeaders(statusCommentBody, "test-webhook-secret", "issue_comment"),
    );
    if (value === undefined) headers.delete(header);
    else headers.set(header, value);
    const send = vi.fn();
    const response = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body: new TextEncoder().encode(statusCommentBody),
        headers,
        method: "POST",
      }),
      { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({ type: "about:blank", title, status });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("rejects an absent or empty Webhook Secret: %j", async (secret) => {
    const send = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", { method: "POST" }),
        {
          GITHUB_APP_ID: "000000",
          GITHUB_WEBHOOK_JOBS: { send },
          ...(secret === undefined ? {} : { GITHUB_WEBHOOK_SECRET: secret }),
        },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        status: 500,
        title: "Internal Server Error",
        type: "about:blank",
      });
      expect(error).toHaveBeenCalledExactlyOnceWith("webhook_receiver_not_configured");
      expect(send).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it.each([".", "..", "high surrogate", "low surrogate"])(
    "acknowledges without publishing a status job with an invalid repository segment: %s",
    async (example) => {
      const name = example.endsWith("surrogate")
        ? String.fromCharCode(example === "high surrogate" ? 0xd800 : 0xdfff)
        : example;
      const send = vi.fn();
      const body = JSON.stringify({
        action: "created",
        comment: { body: "/cyspbot status", id: 42 },
        repository: { name, owner: { login: "owner" } },
      });
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", {
          body,
          headers: githubWebhookHeaders(body, "test-webhook-secret", "issue_comment"),
          method: "POST",
        }),
        { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([[255], [192, 175], [226, 128]])(
    "rejects malformed UTF-8 only after authenticating its exact bytes: %j",
    async (...invalid) => {
      const body = new Uint8Array([34, ...invalid, 34]);
      const send = vi.fn();
      for (const [secret, status] of [
        ["test-webhook-secret", 400],
        ["wrong-secret", 401],
      ] as const) {
        const response = await fetchGitHubWebhookReceiver(
          new Request("https://example.test/github/webhooks", {
            body,
            headers: githubWebhookHeaders(body, secret, "ping"),
            method: "POST",
          }),
          { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe(
          "application/problem+json; charset=utf-8",
        );
        await response.body?.cancel();
      }
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, "null"],
    [42, "42"],
    [{}, "[object Object]"],
    [{ length: 1 }, "[object Object]"],
    [["test-webhook-secret"], "test-webhook-secret"],
  ] as const)(
    "rejects a non-string Secrets Store result before authentication: %j",
    async (value, coercedSecret) => {
      const body = "{}";
      const send = vi.fn();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const response = await fetchGitHubWebhookReceiver(
          new Request("https://example.test/github/webhooks", {
            body,
            headers: githubWebhookHeaders(body, coercedSecret, "ping"),
            method: "POST",
          }),
          {
            ...testWebhookConfig,
            GITHUB_WEBHOOK_JOBS: { send },
            GITHUB_WEBHOOK_SECRET: { get: async () => value } as unknown as SecretsStoreSecret,
          },
        );
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
          status: 500,
          title: "Internal Server Error",
          type: "about:blank",
        });
        expect(send).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledExactlyOnceWith("webhook_receiver_secret_unavailable");
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it.each([undefined, null, "", " ", "not-an-app-id", 42])(
    "rejects an invalid GitHub App ID configuration before accepting a delivery: %j",
    async (appId) => {
      const body = "{}";
      const send = vi.fn();
      const headers = new Headers(githubWebhookHeaders(body, "test-webhook-secret", "ping"));
      headers.delete("x-github-hook-installation-target-id");
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", { body, headers, method: "POST" }),
        {
          ...testWebhookConfig,
          GITHUB_APP_ID: appId as unknown as string,
          GITHUB_WEBHOOK_JOBS: { send },
        },
      );
      expect(response.status).toBe(500);
      await response.body?.cancel();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("returns a safe configuration error when Secrets Store cannot resolve the secret", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn();
    try {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", { method: "POST" }),
        {
          ...testWebhookConfig,
          GITHUB_WEBHOOK_JOBS: { send },
          GITHUB_WEBHOOK_SECRET: {
            get: async () => {
              throw new Error("private secret binding failure details");
            },
          },
        },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        status: 500,
        title: "Internal Server Error",
        type: "about:blank",
      });
      expect(consoleError).toHaveBeenCalledExactlyOnceWith("webhook_receiver_secret_unavailable");
      expect(send).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("acknowledges signed non-ping webhook deliveries without dispatching", async () => {
    const send = vi.fn();
    const body = JSON.stringify({
      action: "opened",
      issue: {
        number: 12,
      },
    });

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues", "delivery-issues"),
        method: "POST",
      }),
      { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts signed github ping webhook deliveries", async () => {
    const send = vi.fn();
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human: caf\u00e9 \ud83d\udc40 \ufffd",
    });

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true, event: "ping" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not return 202 for a status command until the queue write completes", async () => {
    const publishing = Promise.withResolvers<void>();
    const publication = Promise.withResolvers<void>();
    const body = JSON.stringify({
      action: "created",
      comment: { body: "/cyspbot status", id: 42 },
      repository: { name: "cyspbot", owner: { login: "chikachow" } },
    });
    let responded = false;
    const response = fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issue_comment"),
        method: "POST",
      }),
      {
        ...testWebhookConfig,
        GITHUB_WEBHOOK_JOBS: {
          send: () => {
            publishing.resolve();
            return publication.promise;
          },
        },
      },
    ).then((result) => {
      responded = true;
      return result;
    });
    try {
      await publishing.promise;
      // Allow an HTTP response to settle if the queue write was not awaited.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(responded).toBe(false);
    } finally {
      publication.resolve();
      await response;
    }
    expect((await response).status).toBe(202);
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

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issue_comment", "delivery-job"),
        method: "POST",
      }),
      {
        ...testWebhookConfig,
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

  it("returns service unavailable and safe diagnostics when publication fails", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("private payload"), { name: "private exception name" });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", {
          body: statusCommentBody,
          headers: githubWebhookHeaders(statusCommentBody, "test-webhook-secret", "issue_comment"),
          method: "POST",
        }),
        { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        status: 503,
        title: "Service Unavailable",
        type: "about:blank",
      });
      expect(send).toHaveBeenCalledExactlyOnceWith(statusReactionJob, { contentType: "json" });
      expect(error).toHaveBeenCalledExactlyOnceWith("github_webhook_job_enqueue_failed", {
        deliveryId: "delivery-123",
        event: "issue_comment",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("reads the webhook secret from Cloudflare Secrets Store when bound", async () => {
    const send = vi.fn();
    const body = JSON.stringify({
      hook: {
        active: true,
      },
      zen: "Speak like a human.",
    });

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "ping"),
        method: "POST",
      }),
      {
        GITHUB_APP_ID: testWebhookConfig.GITHUB_APP_ID,
        GITHUB_WEBHOOK_JOBS: { send },
        GITHUB_WEBHOOK_SECRET: {
          get: async () => "test-webhook-secret",
        },
      },
    );

    expect(result.status).toBe(202);
    await expect(result.json()).resolves.toEqual({ accepted: true, event: "ping" });
    expect(send).not.toHaveBeenCalled();
  });

  it("publishes each matching delivery when a signed delivery id repeats", async () => {
    const send = vi.fn(async () => ({}));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", {
          body: statusCommentBody,
          headers: githubWebhookHeaders(statusCommentBody, "test-webhook-secret", "issue_comment"),
          method: "POST",
        }),
        { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ accepted: true });
    }
    expect(send.mock.calls).toEqual([
      [statusReactionJob, { contentType: "json" }],
      [statusReactionJob, { contentType: "json" }],
    ]);
  });

  it("rejects invalid json after authenticating the delivery", async () => {
    const body = "{";
    const send = vi.fn();

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers: githubWebhookHeaders(body, "test-webhook-secret", "issues"),
        method: "POST",
      }),
      { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
    );

    expect(result.status).toBe(400);
    await result.body?.cancel();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without publishing and logs only safe metadata", async () => {
    const send = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", {
          body: statusCommentBody,
          headers: {
            ...githubWebhookHeaders(statusCommentBody, "wrong-secret", "issue_comment"),
            "cf-ray": "ray-123",
          },
          method: "POST",
        }),
        { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        status: 401,
        title: "Unauthorized",
        type: "about:blank",
      });
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("github_webhook_rejected", {
        deliveryId: "delivery-123",
        event: "issue_comment",
        rayId: "ray-123",
        status: 401,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an unreadable delivery without publishing or exposing the stream error", async () => {
    const send = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await fetchGitHubWebhookReceiver(
        new Request("https://example.test/github/webhooks", {
          method: "POST",
          headers: githubWebhookHeaders("{}", "test-webhook-secret", "issue_comment"),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("private transport details"));
            },
          }),
        }),
        { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        status: 400,
        title: "Bad Request",
        type: "about:blank",
      });
      expect(send).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects oversized streamed bodies without relying on content-length", async () => {
    const send = vi.fn();
    const body = JSON.stringify({
      payload: "x".repeat(256 * 1024),
    });
    const request = new Request("https://example.test/github/webhooks", {
      body: new Blob([body]).stream(),
      headers: githubWebhookHeaders(body, "test-webhook-secret", "issues"),
      method: "POST",
    });

    expect(request.headers.get("content-length")).toBeNull();

    const result = await fetchGitHubWebhookReceiver(request, {
      ...testWebhookConfig,
      GITHUB_WEBHOOK_JOBS: { send },
    });

    expect(result.status).toBe(413);
    await result.body?.cancel();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["missing prefix", "a".repeat(64)],
    ["short digest", `sha256=${"a".repeat(63)}`],
    ["uppercase digest", `sha256=${"A".repeat(64)}`],
    ["non-hex digest", `sha256=${"g".repeat(64)}`],
  ])("rejects malformed signatures: %s", async (_name, signatureHeader) => {
    const send = vi.fn();
    const body = statusCommentBody;
    const headers = {
      ...githubWebhookHeaders(body, "test-webhook-secret", "issue_comment"),
      "x-hub-signature-256": signatureHeader,
    };

    const result = await fetchGitHubWebhookReceiver(
      new Request("https://example.test/github/webhooks", {
        body,
        headers,
        method: "POST",
      }),
      { ...testWebhookConfig, GITHUB_WEBHOOK_JOBS: { send } },
    );

    expect(result.status).toBe(401);
    await result.body?.cancel();
    expect(send).not.toHaveBeenCalled();
  });
});
