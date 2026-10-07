import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Token Endpoint Proxy entrypoint", () => {
  it("forwards over HTTPS to the configured broker endpoint", async () => {
    const body = "subject_token=unchanged%2Bbytes";
    const response = await exports.default.fetch("https://vanity.example/token?ignored=1", {
      method: "POST",
      body,
      headers: {
        "cf-connecting-ip": "192.0.2.17",
        "x-real-ip": "198.51.100.99",
        host: "untrusted.example",
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-fixture-real-ip")).toBe("192.0.2.17");
    expect(response.headers.get("x-fixture-host")).toBe("broker.example");
    expect(response.headers.get("x-fixture-method")).toBe("POST");
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.text()).resolves.toBe(body);
  });

  it("rejects a redirect returned over HTTPS", async () => {
    const response = await exports.default.fetch("https://vanity.example/token", {
      method: "POST",
      body: "subject_token=unchanged",
      headers: { "x-fixture-response": "redirect" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
  });

  it.each(["/", "/token/", "/tokenized"])("rejects %s", async (path) => {
    const response = await exports.default.fetch(`https://vanity.example${path}`);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });
});
