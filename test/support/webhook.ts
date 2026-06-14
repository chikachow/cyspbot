import { createHmac } from "node:crypto";

import { testEnv } from "./worker.ts";

export function githubWebhookHeaders(
  body: string,
  secret: string,
  event = "installation_repositories",
  deliveryId = "delivery-123",
): Record<string, string> {
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-github-hook-installation-target-id": testEnv.GITHUB_APP_ID,
    "x-github-hook-installation-target-type": "integration",
    "x-hub-signature-256": `sha256=${signature}`,
  };
}
