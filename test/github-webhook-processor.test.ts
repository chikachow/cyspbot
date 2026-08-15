import { describe, expect, it, vi } from "vitest";

import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
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
  it("requests issues:write and adds an eyes reaction", async () => {
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
    expect(githubRequests[0]?.body).toBe(JSON.stringify({ content: "eyes" }));

    const requestBody = brokerRequests[0]?.body;
    if (!(requestBody instanceof URLSearchParams)) {
      throw new TypeError("expected a URLSearchParams token-exchange body");
    }

    expect(Object.fromEntries(requestBody)).toMatchObject({
      resource: "https://api.github.com/repos/chikachow/cyspbot",
      scope: "issues:write",
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

  it("retries a rate-limited forbidden response", async () => {
    const worker = createGitHubWebhookProcessorWorker({
      fetch: async () =>
        new Response(null, { headers: { "x-ratelimit-remaining": "0" }, status: 403 }),
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
    onBrokerRequest?: (input: RequestInfo | URL, init: RequestInit | undefined) => void;
  } = {},
): TokenExchangeEnvironment {
  return {
    GITHUB_APP_TOKEN_BROKER: {
      fetch(input, init) {
        options.onBrokerRequest?.(input, init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "ghs_test_token",
              expires_in: 300,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              scope: "issues:write",
              token_type: "Bearer",
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        );
      },
    },
    GITHUB_APP_TOKEN_BROKER_TOKEN_ENDPOINT: "https://broker.example/token",
    WORKLOAD_IDENTITY_ISSUER: {
      issueToken: async () => ({ token: "eyJ.test.workload.identity" }),
    },
    WORKLOAD_IDENTITY_TOKEN_AUDIENCE: "https://cyspbot.example",
  };
}
