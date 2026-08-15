import { describe, expect, it, vi } from "vitest";

import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { GitHubReactionError } from "@cyspbot/github-webhook-processor/github/reactions";
import { createGitHubWebhookProcessorWorker } from "@cyspbot/github-webhook-processor/worker";
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

  it("keeps header diagnostics when the GitHub error body exceeds the limit", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response("x".repeat(16 * 1024 + 1), {
          headers: { "x-github-request-id": "OVERSIZED" },
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
          github: { requestId: "OVERSIZED" },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
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

  it("keeps header diagnostics when the GitHub error body cannot be read", async () => {
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

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleError).toHaveBeenCalledWith(
        "github_webhook_job_failed",
        expect.objectContaining({
          github: { requestId: "UNREADABLE" },
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
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
                : { error: "token_exchange_failed" },
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
