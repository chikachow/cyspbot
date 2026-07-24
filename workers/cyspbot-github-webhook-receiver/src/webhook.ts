import { jsonResponse, problemResponse } from "@cyspbot/http/problem-details";
import {
  acceptGitHubWebhookDelivery,
  type GitHubWebhookReceiverDependencies,
} from "./github-webhooks/acceptance.ts";

export async function handleGitHubWebhookRequest(
  request: Request,
  env: GitHubWebhookReceiverBindings,
  dependencies: GitHubWebhookReceiverDependencies,
): Promise<Response> {
  const result = await acceptGitHubWebhookDelivery(request, env, dependencies);

  if (result.kind === "accepted") {
    return jsonResponse(result.body, { status: result.status });
  }

  return problemResponse(result.status);
}
