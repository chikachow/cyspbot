import { createCyspbotWorker } from "@cyspbot/cyspbot/worker";
import { describe, expect, it } from "vitest";

const cyspbot = createCyspbotWorker();

describe("cyspbot", () => {
  it("renders its minimal bot page at the root", async () => {
    const response = await fetchCyspbot("https://cyspbot.chikachow.org/?beep=boop");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    await expect(response.text()).resolves.toBe(
      "<!doctype html><title>cyspbot</title><p>beep, boop. i am a bot.</p>",
    );
  });

  it("responds to a root HEAD request without rendering a body", async () => {
    const response = await fetchCyspbot("https://cyspbot.chikachow.org/", {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    await expect(response.text()).resolves.toBe("");
  });

  it.each(["POST", "PUT", "DELETE"])(
    "returns an empty 405 response for %s at the root",
    async (method) => {
      const response = await fetchCyspbot("https://cyspbot.chikachow.org/", { method });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("content-type")).toBeNull();
      await expect(response.text()).resolves.toBe("");
    },
  );

  it.each(["/github/webhooks", "/health", "//"])(
    "returns an empty 404 response for %s",
    async (path) => {
      const response = await fetchCyspbot(`https://cyspbot.chikachow.org${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBeNull();
      await expect(response.text()).resolves.toBe("");
    },
  );

  it("returns an empty 404 for unsupported methods on unknown paths", async () => {
    const response = await fetchCyspbot("https://cyspbot.chikachow.org/health", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("allow")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });
});

function fetchCyspbot(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const handler = cyspbot.fetch;

  if (handler === undefined) {
    throw new Error("cyspbot has no fetch handler");
  }

  return Promise.resolve(
    handler(
      new Request(input, init) as Parameters<typeof handler>[0],
      {} as CyspbotEnv,
      {} as ExecutionContext,
    ),
  );
}
