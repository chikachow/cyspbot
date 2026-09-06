import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "../src/github-webhooks/signature.ts";

describe("GitHub webhook signature verification", () => {
  it.each([
    new Uint8Array(),
    new TextEncoder().encode('{"comment":"👀 café"}'),
    new Uint8Array([0, 255, 128, 13, 10, 1]),
    new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4),
  ])("verifies the exact bytes using an independent HMAC oracle", async (body) => {
    const secret = "webhook-test-secret";
    const signatureHeader = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    await expect(verifyGitHubWebhookSignature({ body, secret, signatureHeader })).resolves.toBe(
      true,
    );
    await expect(
      verifyGitHubWebhookSignature({ body, secret: "different-secret", signatureHeader }),
    ).resolves.toBe(false);
    const changed = new Uint8Array([...body, 0]);
    await expect(
      verifyGitHubWebhookSignature({ body: changed, secret, signatureHeader }),
    ).resolves.toBe(false);
  });
});
