import { env } from "cloudflare:workers";

type TestEnv = GitHubWebhookReceiverEnv;

const workerEnv = env as unknown as TestEnv;

export const testEnv: TestEnv = {
  ...workerEnv,
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};
