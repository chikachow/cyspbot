import { describe, expect, it, vi } from "vitest";

import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { GitHubReactionError, type GitHubReactionDependencies } from "../src/github/reactions.ts";
import { createGitHubWebhookProcessorWorker } from "../src/worker.ts";
import type { TokenExchangeEnvironment } from "@cyspbot/token-exchange";

const job: GitHubIssueCommentStatusReactionJob = {
  commentId: 42,
  deliveryId: "delivery-123",
  kind: "github.issue-comment.status-reaction",
  repository: {
    name: "cyspbot",
    owner: "chikachow",
  },
  version: 1,
};

describe("cyspbot-github-webhook-processor", () => {
  it("defaults GitHub reaction error diagnostics to an empty object", () => {
    expect(new GitHubReactionError(403, false).diagnostics).toEqual({});
  });

  it("requests comment-write permissions and adds an eyes reaction", async () => {
    const brokerRequests: RequestInit[] = [];
    const githubRequests: RequestInit[] = [];
    const env = createTokenExchangeEnvironment({
      onBrokerRequest(_input, init) {
        brokerRequests.push(init ?? {});
      },
    });
    const worker = createGitHubWebhookProcessorWorker({
      fetch(_input, init) {
        githubRequests.push(init ?? {});
        return Promise.resolve(new Response(null, { status: 201 }));
      },
    });
    const message = createMessage(job);

    await invokeQueue(worker, [message], env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(brokerRequests).toHaveLength(1);
    expect(githubRequests).toHaveLength(1);
    expect(githubRequests[0]?.method).toBe("POST");
    expect(new Headers(githubRequests[0]?.headers).get("authorization")).toBe(
      "Bearer ghs_test_token",
    );
    expect(new Headers(githubRequests[0]?.headers).get("user-agent")).toBe(
      "cyspbot-github-webhook-processor",
    );
    expect(githubRequests[0]?.body).toBe(JSON.stringify({ content: "eyes" }));

    const requestBody = brokerRequests[0]?.body;
    if (!(requestBody instanceof URLSearchParams)) {
      throw new TypeError("expected a URLSearchParams token-exchange body");
    }

    expect(Object.fromEntries(requestBody)).toMatchObject({
      resource: "https://api.github.com/repos/chikachow/cyspbot",
      scope: "issues:write pull_requests:write",
    });
  });

  it.each([200, 201])(
    "acknowledges GitHub %s even when body cancellation rejects",
    async (status) => {
      const cancel = vi.fn(() => Promise.reject(new Error("transport cancellation failed")));
      const worker = createGitHubWebhookProcessorWorker({
        fetch: async () => new Response(new ReadableStream({ cancel }), { status }),
      });
      const message = createMessage(job);

      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(cancel).toHaveBeenCalledOnce();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    },
  );

  it.each([301, 302, 307, 308])("repeats the reaction POST after GitHub %s", async (status) => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetch = vi
      .fn<GitHubReactionDependencies["fetch"]>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status,
          headers: { location: "/repositories/123/issues/comments/42/reactions" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const message = createMessage(job);

    await invokeQueue(
      createGitHubWebhookProcessorWorker({ fetch }),
      [message],
      createTokenExchangeEnvironment(),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Request(fetch.mock.calls[1]?.[0] ?? "https://unexpected.example").url).toBe(
      "https://api.github.com/repositories/123/issues/comments/42/reactions",
    );
    expect(fetch.mock.calls[1]?.[1]).toEqual(fetch.mock.calls[0]?.[1]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: JSON.stringify({ content: "eyes" }),
    });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer ghs_test_token",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([
    [301, "https://elsewhere.example/reactions"],
    [302, "http://api.github.com/reactions"],
    [307, "https://user:password@api.github.com/reactions"],
    [308, "https://api.github.com:444/reactions"],
    [301, "https://[invalid"],
    [302, undefined],
    [303, "https://api.github.com/reactions"],
  ] as const)(
    "does not send credentials to a rejected %s redirect %s",
    async (status, location) => {
      const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
        async () =>
          new Response(null, { status, headers: location === undefined ? {} : { location } }),
      );
      const message = createMessage(job);
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment(),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    },
  );

  it("stops after three GitHub reaction redirects", async () => {
    const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
      async () => new Response(null, { status: 301, headers: { location: "/loop" } }),
    );
    const message = createMessage(job);
    await invokeQueue(
      createGitHubWebhookProcessorWorker({ fetch }),
      [message],
      createTokenExchangeEnvironment(),
    );
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([200, 201])(
    "acknowledges GitHub %s without waiting for body cancellation",
    async (status) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const worker = createGitHubWebhookProcessorWorker({
        fetch: async () => new Response(new ReadableStream({ cancel }), { status }),
      });
      const message = createMessage(job);

      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(cancel).toHaveBeenCalledOnce();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    },
  );

  it("retries transient GitHub failures", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => new Response(null, { status: 503 }),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries transient broker failures", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => new Response(null, { status: 201 }),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment({ brokerStatus: 503 }));
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it.each([
    [503, { "retry-after": "120" }, 120],
    [403, {}, 60],
    [400, {}, undefined],
  ] as const)("bounds stalled GitHub %s diagnostics", async (status, headers, delaySeconds) => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{"message":"unavailable"}'));
        },
        pull() {
          reading.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const message = createMessage(job);
    const processing = invokeQueue(
      createGitHubWebhookProcessorWorker({
        fetch: async () =>
          new Response(body, {
            status,
            headers: { ...headers, "x-github-request-id": "STALLED" },
          }),
      }),
      [message],
      createTokenExchangeEnvironment(),
    );

    try {
      await reading.promise;
      await vi.advanceTimersByTimeAsync(999);
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(cancel).toHaveBeenCalledOnce();
      if (delaySeconds === undefined) {
        expect(message.ack).toHaveBeenCalledOnce();
        expect(message.retry).not.toHaveBeenCalled();
      } else {
        expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds });
        expect(message.ack).not.toHaveBeenCalled();
      }
      expect([...consoleWarn.mock.calls, ...consoleError.mock.calls]).toEqual([
        [
          expect.any(String),
          expect.objectContaining({
            github: expect.objectContaining({ bodyReadTimedOut: true, requestId: "STALLED" }),
            status,
          }),
        ],
      ]);
      await processing;
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (cancel.mock.calls.length === 0) bodyController?.close();
      await processing;
      consoleWarn.mockRestore();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("acknowledges permanent broker failures", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => new Response(null, { status: 201 }),
    });
    const message = createMessage(job);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment({ brokerStatus: 400 }));
    } finally {
      consoleError.mockRestore();
    }

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries unexpected token-exchange failures", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => new Response(null, { status: 201 }),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(
        worker,
        [message],
        createTokenExchangeEnvironment({
          issuer: {
            issueToken: async () => {
              throw "issuer unavailable";
            },
          },
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acknowledges a non-rate-limited forbidden response", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => new Response(null, { status: 403 }),
    });
    const message = createMessage(job);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());
    } finally {
      consoleError.mockRestore();
    }

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("logs bounded GitHub response details for a permanent failure", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response(
          JSON.stringify({
            documentation_url:
              "https://docs.github.com/rest/reactions/reactions#create-reaction-for-an-issue-comment",
            message: "Resource not accessible by integration",
            private_detail: "do not log this",
            status: "403",
          }),
          {
            headers: {
              "x-accepted-github-permissions": "issues=write",
              "x-github-request-id": "ABC123",
              "x-ratelimit-remaining": "4997",
            },
            status: 403,
          },
        ),
    });
    const message = createMessage(job);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleError).toHaveBeenCalledWith(
        "github_webhook_job_failed",
        expect.objectContaining({
          github: {
            acceptedPermissions: "issues=write",
            documentationUrl:
              "https://docs.github.com/rest/reactions/reactions#create-reaction-for-an-issue-comment",
            message: "Resource not accessible by integration",
            rateLimitRemaining: "4997",
            requestId: "ABC123",
          },
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("do not log this");
    } finally {
      consoleError.mockRestore();
    }

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a forbidden response when its body exceeds the limit", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response("x".repeat(16 * 1024 + 1), {
          headers: { "x-github-request-id": "OVERSIZED" },
          status: 403,
        }),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({
          github: { bodyReadFailed: true, requestId: "OVERSIZED" },
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("keeps header diagnostics when the GitHub error body is not an object", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response("[]", {
          headers: { "x-github-request-id": "NON_OBJECT" },
          status: 403,
        }),
    });
    const message = createMessage(job);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleError).toHaveBeenCalledWith(
        "github_webhook_job_failed",
        expect.objectContaining({
          github: { requestId: "NON_OBJECT" },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ignores absent fields in an object GitHub error body", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response("{}", {
          headers: { "x-github-request-id": "EMPTY_OBJECT" },
          status: 403,
        }),
    });
    const message = createMessage(job);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleError).toHaveBeenCalledWith(
        "github_webhook_job_failed",
        expect.objectContaining({
          github: { requestId: "EMPTY_OBJECT" },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retries a forbidden response when its body cannot be read", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("body unavailable"));
            },
          }),
          {
            headers: { "x-github-request-id": "UNREADABLE" },
            status: 403,
          },
        ),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({
          github: { bodyReadFailed: true, requestId: "UNREADABLE" },
        }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries a rate-limited forbidden response", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response(null, {
          headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
          status: 403,
        }),
    });
    const message = createMessage(job);

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries a secondary rate limit with primary quota remaining", async () => {
    const message = createMessage(job);
    await invokeQueue(
      createGitHubWebhookProcessorWorker({
        fetch: async () =>
          Response.json(
            {
              message:
                "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "4999" },
            },
          ),
      }),
      [message],
      createTokenExchangeEnvironment(),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
  });

  it.each([
    ["retry-after", { "retry-after": "3600" }, 3600],
    ["primary reset", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893457800" }, 1800],
    [
      "both waiting periods",
      { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893457800" },
      1800,
    ],
    ["maximum queue delay", { "retry-after": "172800" }, 86400],
    ["zero delay", { "retry-after": "0" }, 60],
    ["invalid delay", { "retry-after": "1e3" }, 60],
    ["negative delay", { "retry-after": "-1" }, 60],
    ["fractional delay", { "retry-after": "1.5" }, 60],
    ["overflow delay", { "retry-after": "999999999999999999999" }, 60],
    ["past reset", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }, 60],
    [
      "reset with available quota",
      { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1893457800" },
      60,
    ],
  ] as const)("respects %s", async (_name, headers, delaySeconds) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const message = createMessage(job);
      await invokeQueue(
        createGitHubWebhookProcessorWorker({
          fetch: async () => new Response(null, { status: 429, headers }),
        }),
        [message],
        createTokenExchangeEnvironment(),
      );
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off repeated failures without waiting hints", async () => {
    const message = { ...createMessage(job), attempts: 4 };
    await invokeQueue(
      createGitHubWebhookProcessorWorker({
        fetch: async () => new Response(null, { status: 503 }),
      }),
      [message],
      createTokenExchangeEnvironment(),
    );
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 480 });
  });

  it.each([
    ["invalid_scope", "invalid_scope"],
    ["ghs_private_token", "unrecognized_error"],
  ])("logs safe broker diagnostics for %s", async (brokerError, oauthErrorCode) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const message = createMessage({ ...job, deliveryId: "d".repeat(200) });
    try {
      await invokeQueue(
        createGitHubWebhookProcessorWorker({
          fetch: async () => {
            throw new Error("GitHub must not be called");
          },
        }),
        [message],
        createTokenExchangeEnvironment({ brokerStatus: 400, brokerError }),
      );
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        "github_webhook_job_failed",
        expect.objectContaining({ deliveryId: "d".repeat(128), oauthErrorCode, status: 400 }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private broker description");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ghs_private_token");
    } finally {
      consoleError.mockRestore();
    }
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("keeps the queue default for transport failures", async () => {
    const message = { ...createMessage(job), attempts: 4 };
    await invokeQueue(
      createGitHubWebhookProcessorWorker({
        fetch: async () => {
          throw new TypeError("network unavailable");
        },
      }),
      [message],
      createTokenExchangeEnvironment(),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
  });

  it("acknowledges invalid jobs without calling GitHub", async () => {
    let githubCalls = 0;
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () => {
        githubCalls += 1;
        return new Response(null, { status: 201 });
      },
    });
    const message = createMessage({ ...job, unexpected: true });

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(githubCalls).toBe(0);
  });
});

interface TestMessage {
  readonly attempts: number;
  readonly body: unknown;
  readonly id: string;
  readonly ack: ReturnType<typeof vi.fn>;
  readonly retry: ReturnType<typeof vi.fn>;
}

function createMessage(body: unknown): TestMessage {
  return {
    ack: vi.fn(),
    attempts: 1,
    body,
    id: "message-123",
    retry: vi.fn(),
  };
}

async function invokeQueue(
  worker: ExportedHandler<GitHubWebhookProcessorEnv, unknown>,
  messages: TestMessage[],
  env: TokenExchangeEnvironment,
): Promise<void> {
  if (worker.queue === undefined) {
    throw new Error("expected a queue handler");
  }

  await worker.queue(
    {
      messages,
      queue: "cyspbot-github-webhook-jobs",
    } as unknown as MessageBatch<unknown>,
    env as GitHubWebhookProcessorEnv,
    {} as ExecutionContext,
  );
}

function createTokenExchangeEnvironment(
  options: {
    brokerStatus?: number;
    brokerError?: string;
    issuer?: { issueToken(audience: string): Promise<unknown> };
    onBrokerRequest?: (input: RequestInfo | URL, init: RequestInit | undefined) => void;
  } = {},
): TokenExchangeEnvironment {
  return {
    GITHUB_APP_TOKEN_BROKER: {
      fetch(input, init) {
        options.onBrokerRequest?.(input, init);
        return Promise.resolve(
          new Response(
            JSON.stringify(
              options.brokerStatus === undefined || options.brokerStatus === 200
                ? {
                    access_token: "ghs_test_token",
                    expires_in: 300,
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    scope: "issues:write pull_requests:write",
                    token_type: "Bearer",
                  }
                : {
                    error: options.brokerError ?? "token_exchange_failed",
                    error_description: "private broker description",
                  },
            ),
            {
              headers: { "content-type": "application/json" },
              status: options.brokerStatus ?? 200,
            },
          ),
        );
      },
    },
    GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT: "https://broker.example/token",
    WORKLOAD_IDENTITY_ISSUER: options.issuer ?? {
      issueToken: async () => ({ token: "eyJ.test.workload.identity" }),
    },
    WORKLOAD_IDENTITY_TOKEN_AUDIENCE: "https://cyspbot.example",
  };
}
