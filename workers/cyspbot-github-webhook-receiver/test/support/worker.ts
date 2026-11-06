import githubWebhookReceiverWorker from "@cyspbot/github-webhook-receiver";
import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";

export interface TestWebhookEnv {
  GITHUB_APP_ID: string;
  GITHUB_WEBHOOK_JOBS: {
    send(
      message: GitHubIssueCommentStatusReactionJob,
      options?: { contentType?: "json" },
    ): Promise<unknown>;
  };
  GITHUB_WEBHOOK_SECRET?: string | SecretsStoreSecret;
}

export function fetchGitHubWebhookReceiver(
  request: Request,
  env: TestWebhookEnv,
): Promise<Response> {
  const handler = githubWebhookReceiverWorker.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(
      request as Parameters<typeof handler>[0],
      env as GitHubWebhookReceiverEnv,
      {} as ExecutionContext,
    ),
  );
}
