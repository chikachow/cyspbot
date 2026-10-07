import { afterEach, describe, expect, it, vi } from "vitest";
import { createTokenProxyWorker } from "../src/worker.ts";

const endpoint = "https://broker.example/github/apps/example-app/token";

function invoke(request: Request, fixture: { fetch: unknown; TOKEN_PROXY_ENDPOINT?: unknown }) {
  vi.stubGlobal("fetch", fixture.fetch);
  const env = { TOKEN_PROXY_ENDPOINT: fixture.TOKEN_PROXY_ENDPOINT };
  const handler = createTokenProxyWorker().fetch!;
  return handler(
    request as Parameters<typeof handler>[0],
    env as CyspbotTokenProxyEnv,
    {} as ExecutionContext,
  );
}

describe("Token Endpoint proxy", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([200, 400, 401, 429, 503])(
    "preserves broker status %i, headers and bytes",
    async (status) => {
      const body = new Uint8Array([0, 255, 38, 61, 43]);
      const response = new Response(body, {
        status,
        headers: {
          "cache-control": "no-store",
          pragma: "no-cache",
          "retry-after": "30",
          "www-authenticate": "Bearer",
          location: "https://untrusted.example/",
        },
      });
      const fetch = vi.fn(async (request: Request) => {
        expect(request.url).toBe(endpoint);
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("cf-connecting-ip")).toBe("192.0.2.10");
        expect(request.headers.get("x-real-ip")).toBe("192.0.2.10");
        expect(request.headers.has("host")).toBe(false);
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(body);
        return response;
      });
      const actual = await invoke(
        new Request("https://vanity.example/token?ignored=1", {
          method: "POST",
          body,
          headers: {
            "cf-connecting-ip": "192.0.2.10",
            "x-real-ip": "198.51.100.99",
            host: "untrusted.example",
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
        { fetch, TOKEN_PROXY_ENDPOINT: endpoint },
      );
      expect(actual).toBe(response);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399])(
    "rejects upstream %i without exposing redirect headers or body",
    async (status) => {
      const cancel = vi.fn();
      const body = status === 304 ? null : new ReadableStream({ cancel });
      const fetch = vi.fn(
        async () =>
          new Response(body, {
            status,
            headers: {
              location: "https://untrusted.example/",
              "x-diagnostic": "secret",
              "retry-after": "30",
            },
          }),
      );
      const response = await invoke(
        new Request("https://vanity.example/token", {
          method: "POST",
          body: "subject_token=secret",
        }),
        { fetch, TOKEN_PROXY_ENDPOINT: endpoint },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.has("location")).toBe(false);
      expect(response.headers.has("x-diagnostic")).toBe(false);
      expect(response.headers.has("retry-after")).toBe(false);
      await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
      if (body !== null) expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("does not await or expose failed redirect body cancellation", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("secret cancellation diagnostic");
    });
    const response = await invoke(new Request("https://vanity.example/token"), {
      fetch: async () => new Response(new ReadableStream({ cancel }), { status: 307 }),
      TOKEN_PROXY_ENDPOINT: endpoint,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns the sanitized error while redirect body cancellation remains pending", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = await invoke(new Request("https://vanity.example/token"), {
      fetch: async () => new Response(new ReadableStream({ cancel }), { status: 308 }),
      TOKEN_PROXY_ENDPOINT: endpoint,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "HEAD", "PUT", "OPTIONS"])(
    "forwards %s for the broker to classify",
    async (method) => {
      const fetch = vi.fn(async (request: Request) => {
        expect(request.method).toBe(method);
        expect(request.headers.has("cf-connecting-ip")).toBe(false);
        expect(request.headers.has("x-real-ip")).toBe(false);
        return new Response(null, { status: 400 });
      });
      expect(
        (
          await invoke(
            new Request("https://vanity.example/token", {
              method,
              headers: { "x-real-ip": "198.51.100.99" },
            }),
            {
              fetch,
              TOKEN_PROXY_ENDPOINT: endpoint,
            },
          )
        ).status,
      ).toBe(400);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/", "/token/", "/tokenized", "/github/apps/example-app/token"])(
    "does not forward %s",
    async (path) => {
      const fetch = vi.fn();
      expect(
        (
          await invoke(new Request(`https://vanity.example${path}`), {
            fetch,
          })
        ).status,
      ).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "http://broker.example/github/apps/a/token",
    "https://user:pass@broker.example/github/apps/a/token",
    "https://broker.example/token",
    `${endpoint}?app=other`,
    `${endpoint}#fragment`,
  ])("rejects invalid deployment endpoint %s before I/O", async (url) => {
    const fetch = vi.fn();
    const response = await invoke(new Request("https://vanity.example/token"), {
      fetch,
      TOKEN_PROXY_ENDPOINT: url,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes transport failure without retries", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("secret diagnostic");
    });
    const response = await invoke(
      new Request("https://vanity.example/token", { method: "POST", body: "secret assertion" }),
      {
        fetch,
        TOKEN_PROXY_ENDPOINT: endpoint,
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
