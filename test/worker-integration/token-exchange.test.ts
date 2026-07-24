import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("token exchange Worker entrypoint", () => {
  it("serves the token exchange route with its configured rate limiter", async () => {
    const response = await exports.default.fetch("https://example.test/token", {
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("does not serve the GitHub webhook route", async () => {
    const response = await exports.default.fetch("https://example.test/github/webhooks");

    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});
