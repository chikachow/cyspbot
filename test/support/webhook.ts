import { createHmac } from "node:crypto";

export const githubWebhookTestSecret = "test-webhook-secret";

const githubWebhookTestAppId = "000000";

export function githubWebhookHeaders(
  body: string,
  secret: string,
  event = "installation_repositories",
  deliveryId = "delivery-123",
  targetId = githubWebhookTestAppId,
): Record<string, string> {
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-github-hook-installation-target-id": targetId,
    "x-github-hook-installation-target-type": "integration",
    "x-hub-signature-256": `sha256=${signature}`,
  };
}
