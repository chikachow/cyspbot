import { describe, expect, it } from "vitest";

import { readRequestBodyUpTo } from "@cyspbot/http/request-body";

describe("bounded request body reading", () => {
  it("rejects an unreadable request body as a bad request", async () => {
    const request = new Request("https://example.test", {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private transport details"));
        },
      }),
      method: "POST",
    });
    await expect(readRequestBodyUpTo(request, 1024)).resolves.toEqual({ ok: false, status: 400 });
    expect(request.body?.locked).toBe(false);
  });

  it("accepts a Content-Length with leading zeroes", async () => {
    const result = await readRequestBodyUpTo(
      new Request("https://example.test", {
        body: "x",
        headers: { "content-length": "0001" },
        method: "POST",
      }),
      1,
    );

    expect(result).toEqual({
      bytes: new TextEncoder().encode("x"),
      ok: true,
    });
  });

  it("rejects an arbitrarily large Content-Length as too large without integer conversion", async () => {
    const result = await readRequestBodyUpTo(
      new Request("https://example.test", {
        body: "x",
        headers: { "content-length": "9".repeat(400) },
        method: "POST",
      }),
      1,
    );

    expect(result).toEqual({ ok: false, status: 413 });
  });

  it.each(["", "+1", "-1", "1.0", "1e3"])(
    "rejects a Content-Length outside the HTTP decimal grammar: %j",
    async (contentLength) => {
      const result = await readRequestBodyUpTo(
        new Request("https://example.test", {
          body: "x",
          headers: { "content-length": contentLength },
          method: "POST",
        }),
        1,
      );

      expect(result).toEqual({ ok: false, status: 400 });
    },
  );
});
