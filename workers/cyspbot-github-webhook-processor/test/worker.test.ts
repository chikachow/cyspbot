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
    expect(new GitHubReactionError(403).diagnostics).toEqual({});
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

  it("preserves the validated repository and comment while Workload Identity Token issuance is pending", async () => {
    const issuing = Promise.withResolvers<void>();
    const issued = Promise.withResolvers<{ token: string }>();
    const incoming = { ...job, repository: { ...job.repository } };
    const message = createMessage(incoming);
    const brokerRequest = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => void>();
    const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
      async () => new Response(null, { status: 201 }),
    );
    const processing = invokeQueue(
      createGitHubWebhookProcessorWorker({ fetch }),
      [message],
      createTokenExchangeEnvironment({
        issuer: {
          issueToken: () => {
            issuing.resolve();
            return issued.promise;
          },
        },
        onBrokerRequest: brokerRequest,
      }),
    );
    await issuing.promise;
    incoming.commentId = 99;
    incoming.repository.owner = "changed-owner";
    incoming.repository.name = "changed-repository";
    expect(message.ack).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    issued.resolve({ token: "eyJ.test.workload.identity" });
    await processing;
    const requestBody = brokerRequest.mock.calls[0]?.[1]?.body;
    if (!(requestBody instanceof URLSearchParams))
      throw new TypeError("expected token request body");
    expect(requestBody.get("resource")).toBe("https://api.github.com/repos/chikachow/cyspbot");
    const reactionUrl = fetch.mock.calls[0]?.[0];
    if (!(reactionUrl instanceof URL)) throw new TypeError("expected reaction URL");
    expect(reactionUrl.href).toBe(
      "https://api.github.com/repos/chikachow/cyspbot/issues/comments/42/reactions",
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
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

  describe.each([0, 3])("after %s permitted redirects", (redirects) => {
    it.each([
      [301, "https://elsewhere.example/reactions"],
      [302, "http://api.github.com/reactions"],
      [307, "https://user:password@api.github.com/reactions"],
      [308, "https://api.github.com:444/reactions"],
      [302, undefined],
      [303, "https://api.github.com/reactions"],
    ] as const)(
      "does not send credentials to a rejected %s redirect %s",
      async (status, location) => {
        const fetch = vi.fn<GitHubReactionDependencies["fetch"]>();
        for (let index = 0; index < redirects; index += 1) {
          fetch.mockResolvedValueOnce(
            new Response(null, { status: 301, headers: { location: "/permitted" } }),
          );
        }
        fetch.mockResolvedValueOnce(
          new Response(null, { status, headers: location === undefined ? {} : { location } }),
        );
        const message = createMessage(job);
        await invokeQueue(
          createGitHubWebhookProcessorWorker({ fetch }),
          [message],
          createTokenExchangeEnvironment(),
        );
        expect(fetch).toHaveBeenCalledTimes(redirects + 1);
        expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
        expect(message.ack).not.toHaveBeenCalled();
        expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      },
    );
  });

  it.each([301, 302, 307, 308])("retries an unparseable GitHub %s redirect", async (status) => {
    const location = "https://user:private-password@[invalid";
    const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
      async () =>
        new Response(null, {
          status,
          headers: { location, "retry-after": "120", "x-github-request-id": "REDIRECT" },
        }),
    );
    const message = { ...createMessage(job), attempts: 3 };
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment(),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 120 });
      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({
          status,
          github: {
            redirectFailure: "invalid_location",
            requestId: "REDIRECT",
            retryAfter: "120",
          },
        }),
      );
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("private-password");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("completes a reaction after exactly three GitHub redirects", async () => {
    const fetch = vi.fn<GitHubReactionDependencies["fetch"]>();
    for (let index = 0; index < 3; index += 1) {
      fetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: `/redirect-${index}` } }),
      );
    }
    fetch.mockResolvedValueOnce(new Response(null, { status: 201 }));
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

  it.each([
    ["/loop", "too_many_redirects"],
    ["", "too_many_redirects"],
    ["https://[invalid", "invalid_location"],
  ] as const)("retries a fourth redirect to %s with backoff", async (location, redirectFailure) => {
    const fetch = vi.fn<GitHubReactionDependencies["fetch"]>();
    for (let index = 0; index < 3; index += 1) {
      fetch.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "/permitted" } }),
      );
    }
    fetch.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location } }));
    const message = { ...createMessage(job), attempts: 3 };
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment(),
      );
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 240 });
      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({ status: 301, github: { redirectFailure } }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
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
    [400, {}, 60],
    [422, { "retry-after": "600" }, 600],
  ] as const)("bounds stalled GitHub %s diagnostics", async (status, headers, delaySeconds) => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds });
      expect(message.ack).not.toHaveBeenCalled();
      expect(consoleWarn.mock.calls).toEqual([
        [
          "github_webhook_job_retrying",
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
      vi.useRealTimers();
    }
  });

  it.each([301, 400, 401, 403, 404, 408, 422, 429, 500, 503])(
    "retries broker %s without calling GitHub",
    async (brokerStatus) => {
      const fetch = vi.fn<GitHubReactionDependencies["fetch"]>();
      const message = createMessage(job);
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment({ brokerStatus }),
      );
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["HTML", 404, "<html>Not found</html>"],
    ["malformed JSON", 404, "{"],
    ["missing error code", 404, "{}"],
    ["empty body", 404, ""],
    ["oversized body", 404, "x".repeat(64 * 1024 + 1)],
    ["invalid success", 200, "{}"],
  ] as const)(
    "retries a broker %s response without calling GitHub",
    async (_name, brokerStatus, brokerBody) => {
      const fetch = vi.fn<GitHubReactionDependencies["fetch"]>();
      const message = createMessage(job);
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment({ brokerStatus, brokerBody }),
      );
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["issuer", "broker", "github"])(
    "retries %s transport failures without logging dependency exception names",
    async (source) => {
      const fail = async () => {
        throw Object.assign(new Error("private failure details"), { name: "private credential" });
      };
      const env = { ...createTokenExchangeEnvironment() };
      if (source === "issuer") env.WORKLOAD_IDENTITY_ISSUER = { issueToken: fail };
      if (source === "broker") env.GITHUB_APP_TOKEN_BROKER.fetch = fail;
      const fetch = vi.fn(
        source === "github" ? fail : async () => new Response(null, { status: 201 }),
      );
      const message = createMessage(job);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await invokeQueue(createGitHubWebhookProcessorWorker({ fetch }), [message], env);
        expect(message.retry).toHaveBeenCalledExactlyOnceWith();
        expect(message.ack).not.toHaveBeenCalled();
        expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("private");
        if (source !== "github") expect(fetch).not.toHaveBeenCalled();
      } finally {
        consoleWarn.mockRestore();
      }
    },
  );

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

  it.each([202, 204, 400, 401, 403, 404, 422])(
    "retries unsuccessful GitHub %s responses with backoff",
    async (status) => {
      const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
        async () => new Response(null, { status }),
      );
      const message = { ...createMessage(job), attempts: 3 };
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment(),
      );
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 240 });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("logs bounded GitHub response details while retrying", async () => {
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

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
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
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("do not log this");
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
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

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({
          github: { requestId: "NON_OBJECT" },
        }),
      );
    } finally {
      consoleWarn.mockRestore();
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

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(worker, [message], createTokenExchangeEnvironment());

      expect(consoleWarn).toHaveBeenCalledWith(
        "github_webhook_job_retrying",
        expect.objectContaining({
          github: { requestId: "EMPTY_OBJECT" },
        }),
      );
    } finally {
      consoleWarn.mockRestore();
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

  it("honors the retry delay on a validation or spam response", async () => {
    const message = createMessage(job);
    await invokeQueue(
      createGitHubWebhookProcessorWorker({
        fetch: async () => new Response(null, { status: 422, headers: { "retry-after": "600" } }),
      }),
      [message],
      createTokenExchangeEnvironment(),
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 600 });
  });

  it("continues a batch after retrying a failed job", async () => {
    const fetch = vi
      .fn<GitHubReactionDependencies["fetch"]>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const failed = createMessage(job);
    const completed = createMessage({ ...job, commentId: 43 });
    await invokeQueue(
      createGitHubWebhookProcessorWorker({ fetch }),
      [failed, completed],
      createTokenExchangeEnvironment(),
    );
    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(completed.ack).toHaveBeenCalledOnce();
    expect(completed.retry).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
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
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
        "github_webhook_job_retrying",
        expect.objectContaining({ deliveryId: "d".repeat(128), oauthErrorCode, status: 400 }),
      );
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("private broker description");
      expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain("ghs_private_token");
    } finally {
      consoleWarn.mockRestore();
    }
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
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

  it.each(["broker", "GitHub"] as const)(
    "still requests a retry for a %s failure on the final configured attempt",
    async (failure) => {
      const fetch = vi.fn<GitHubReactionDependencies["fetch"]>(
        async () => new Response(null, { status: 404 }),
      );
      const message = { ...createMessage(job), attempts: 6 };
      await invokeQueue(
        createGitHubWebhookProcessorWorker({ fetch }),
        [message],
        createTokenExchangeEnvironment({ brokerStatus: failure === "broker" ? 403 : 200 }),
      );

      expect(message.ack).not.toHaveBeenCalled();
      if (failure === "broker") {
        expect(message.retry).toHaveBeenCalledExactlyOnceWith();
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 1920 });
        expect(fetch).toHaveBeenCalledOnce();
      }
    },
  );

  it("requests fresh credentials when a failed job succeeds on its next delivery", async () => {
    const issuer = {
      issueToken: vi
        .fn()
        .mockResolvedValueOnce({ token: "eyJ.first.identity" })
        .mockResolvedValueOnce({ token: "eyJ.second.identity" }),
    };
    const env = createTokenExchangeEnvironment({ issuer });
    let exchanges = 0;
    const broker = vi.fn<typeof env.GITHUB_APP_TOKEN_BROKER.fetch>(async () =>
      Response.json({
        access_token: `ghs_attempt_${++exchanges}`,
        expires_in: 300,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
      }),
    );
    const retryEnv = { ...env, GITHUB_APP_TOKEN_BROKER: { fetch: broker } };
    const fetch = vi
      .fn<GitHubReactionDependencies["fetch"]>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const worker = createGitHubWebhookProcessorWorker({ fetch });
    const failed = createMessage(job);
    const recovered = { ...createMessage(job), attempts: 2 };

    await invokeQueue(worker, [failed], retryEnv);
    await invokeQueue(worker, [recovered], retryEnv);

    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(recovered.ack).toHaveBeenCalledOnce();
    expect(recovered.retry).not.toHaveBeenCalled();
    expect(issuer.issueToken).toHaveBeenCalledTimes(2);
    expect(broker).toHaveBeenCalledTimes(2);
    expect(
      broker.mock.calls.map(([, init]) =>
        new URLSearchParams(init?.body as URLSearchParams).get("subject_token"),
      ),
    ).toEqual(["eyJ.first.identity", "eyJ.second.identity"]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer ghs_attempt_1", "Bearer ghs_attempt_2"]);
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
    const issuer = { issueToken: vi.fn() };
    const brokerRequest = vi.fn();

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await invokeQueue(
        worker,
        [message],
        createTokenExchangeEnvironment({ issuer, onBrokerRequest: brokerRequest }),
      );
    } finally {
      consoleWarn.mockRestore();
    }

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(githubCalls).toBe(0);
    expect(issuer.issueToken).not.toHaveBeenCalled();
    expect(brokerRequest).not.toHaveBeenCalled();
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
    brokerBody?: string;
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
            options.brokerBody ??
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
