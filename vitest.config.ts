import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

import { githubWebhookTestSecret } from "./test/support/webhook.ts";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "test/**", "worker-configuration.d.ts"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
    },
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_APP_ID: "000000",
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          exclude: [...configDefaults.exclude, "test/worker-integration/**"],
          name: "unit",
        },
      },
      {
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot-token-exchange/wrangler.jsonc",
            },
          }),
        ],
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/token-exchange.test.ts"],
          name: "token-exchange-integration",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_WEBHOOK_SECRET: githubWebhookTestSecret,
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot-github-webhook-receiver/wrangler.jsonc",
            },
          }),
        ],
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/github-webhook-receiver.test.ts"],
          name: "github-webhook-receiver-integration",
        },
      },
    ],
  },
});
