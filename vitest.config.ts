import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

import {
  githubWebhookProcessorOutboundService,
  githubWebhookProcessorBrokerService,
} from "./workers/cyspbot-github-webhook-processor/test/integration/outbound.ts";
import { githubWebhookTestSecret } from "./workers/cyspbot-github-webhook-receiver/test/support/webhook.ts";

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: {
      exclude: ["**/*.d.ts"],
      include: ["packages/*/src/**/*.ts", "workers/*/src/**/*.ts"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
    },
    projects: [
      {
        test: {
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          name: "built-workers-integration",
        },
      },
      {
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot/wrangler.jsonc",
            },
          }),
        ],
        test: {
          detectAsyncLeaks: true,
          include: ["workers/cyspbot/test/integration/**/*.test.ts"],
          name: "cyspbot-integration",
        },
      },
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
          detectAsyncLeaks: true,
          exclude: [
            ...configDefaults.exclude,
            ".pnpm-store/**",
            ".worktrees/**",
            "**/test/integration/**",
          ],
          include: [
            "packages/*/test/**/*.test.ts",
            "workers/*/test/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          name: "unit",
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
          detectAsyncLeaks: true,
          include: ["workers/cyspbot-github-webhook-receiver/test/integration/**/*.test.ts"],
          name: "github-webhook-receiver-integration",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              workers: [
                {
                  modules: [
                    {
                      path: "./workers/cyspbot-github-webhook-processor/test/integration/workload-identity-issuer.mjs",
                      type: "ESModule",
                    },
                  ],
                  name: "workload-identity-issuer-local",
                },
              ],
              serviceBindings: {
                GITHUB_APP_TOKEN_BROKER: githubWebhookProcessorBrokerService,
                WORKLOAD_IDENTITY_ISSUER: {
                  entrypoint: "WorkloadIdentityIssuer",
                  name: "workload-identity-issuer-local",
                },
              },
              outboundService: githubWebhookProcessorOutboundService,
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot-github-webhook-processor/wrangler.jsonc",
            },
          }),
        ],
        test: {
          detectAsyncLeaks: true,
          include: ["workers/cyspbot-github-webhook-processor/test/integration/**/*.test.ts"],
          name: "github-webhook-processor-integration",
        },
      },
    ],
  },
});
