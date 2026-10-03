import { describe, expect, it, vi } from "vitest";
import { createCyspbotWorker } from "../src/worker.ts";

const endpoint = "https://broker.example/github/apps/example-app/token";

function invoke(request: Request, env: unknown) {
  const handler = createCyspbotWorker().fetch!;
  return handler(
    request as Parameters<typeof handler>[0],
    env as CyspbotEnv,
    {} as ExecutionContext,
  );
}

describe("Token Endpoint proxy", () => {
  it.each([200, 400, 401, 429, 503, 307])(
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
            "content-type": "application/x-www-form-urlencoded",
          },
        }),
        { GITHUB_APP_TOKEN_BROKER: { fetch }, TOKEN_PROXY_ENDPOINT: endpoint },
      );
      expect(actual).toBe(response);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["GET", "HEAD", "PUT", "OPTIONS"])(
    "forwards %s for the broker to classify",
    async (method) => {
      const fetch = vi.fn(async (request: Request) => {
        expect(request.method).toBe(method);
        expect(request.headers.has("cf-connecting-ip")).toBe(false);
        return new Response(null, { status: 400 });
      });
      expect(
        (
          await invoke(new Request("https://vanity.example/token", { method }), {
            GITHUB_APP_TOKEN_BROKER: { fetch },
            TOKEN_PROXY_ENDPOINT: endpoint,
          })
        ).status,
      ).toBe(400);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/token/", "/tokenized", "/github/apps/example-app/token"])(
    "does not forward %s",
    async (path) => {
      const fetch = vi.fn();
      expect(
        (
          await invoke(new Request(`https://vanity.example${path}`), {
            GITHUB_APP_TOKEN_BROKER: { fetch },
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
      GITHUB_APP_TOKEN_BROKER: { fetch },
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
        GITHUB_APP_TOKEN_BROKER: { fetch },
        TOKEN_PROXY_ENDPOINT: endpoint,
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
