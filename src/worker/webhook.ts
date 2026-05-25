import type { Env } from "../env.ts";
import { jsonResponse, problemResponse } from "../http/problem-details.ts";
import { acceptGitHubWebhookDelivery } from "../webhook/delivery-acceptance.ts";
import type { AppDependencies } from "./dependencies.ts";

export async function handleGitHubWebhookRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const result = await acceptGitHubWebhookDelivery(request, env, dependencies);

  if (result.kind === "accepted") {
    return jsonResponse(result.body, { status: result.status });
  }

  return problemResponse(result.status);
}
