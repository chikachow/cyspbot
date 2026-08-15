import { env } from "cloudflare:workers";
import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";

type TestEnv = GitHubWebhookReceiverEnv;

const workerEnv = env as unknown as TestEnv;

const testWebhookJobs: GitHubIssueCommentStatusReactionJob[] = [];

const testWebhookJobQueue = {
  send(message: GitHubIssueCommentStatusReactionJob): Promise<unknown> {
    testWebhookJobs.push(message);
    return Promise.resolve({});
  },
};

export const testEnv: TestEnv = {
  ...workerEnv,
  GITHUB_WEBHOOK_JOBS: testWebhookJobQueue as TestEnv["GITHUB_WEBHOOK_JOBS"],
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};
