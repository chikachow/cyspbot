import { env } from "cloudflare:workers";

import { testPrivateKeyPem } from "./constants.ts";

type TestBindings = GitHubWebhookReceiverBindings & TokenExchangeBindings;

const workerEnv = env as unknown as TestBindings;

const testTokenExchangeRateLimit = {
  limit: async () => ({ success: true }),
} satisfies RateLimit;

export const testEnv: TestBindings = {
  ...workerEnv,
  GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  TOKEN_EXCHANGE_RATE_LIMIT: testTokenExchangeRateLimit,
};
