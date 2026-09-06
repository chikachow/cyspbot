import { problemResponse } from "@cyspbot/http/problem-details";
import { handleGitHubWebhookRequest } from "./webhook.ts";

export function createGitHubWebhookReceiverWorker(): ExportedHandler<GitHubWebhookReceiverEnv> {
  return {
    fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname !== "/github/webhooks") {
        return problemResponse(404);
      }

      if (request.method !== "POST") {
        return problemResponse(405, { allow: "POST" });
      }

      return handleGitHubWebhookRequest(request, env);
    },
  };
}
