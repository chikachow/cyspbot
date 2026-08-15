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
              workers: [
                {
                  modules: [
                    {
                      path: "./test/worker-integration/workload-identity-issuer.mjs",
                      type: "ESModule",
                    },
                  ],
                  name: "workload-identity-issuer-local",
                },
              ],
              serviceBindings: {
                GITHUB_APP_TOKEN_BROKER: () =>
                  Response.json({
                    access_token: "ghs_integration_token",
                    expires_in: 300,
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    scope: "contents:read",
                    token_type: "Bearer",
                  }),
                WORKLOAD_IDENTITY_ISSUER: {
                  entrypoint: "WorkloadIdentityIssuer",
                  name: "workload-identity-issuer-local",
                },
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot/wrangler.jsonc",
            },
          }),
        ],
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/cyspbot.test.ts"],
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
          allowOnly: false,
          detectAsyncLeaks: true,
          exclude: [
            ...configDefaults.exclude,
            ".pnpm-store/**",
            ".worktrees/**",
            "test/worker-integration/**",
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
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/github-webhook-receiver.test.ts"],
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
                      path: "./test/worker-integration/workload-identity-issuer.mjs",
                      type: "ESModule",
                    },
                  ],
                  name: "workload-identity-issuer-local",
                },
              ],
              serviceBindings: {
                GITHUB_APP_TOKEN_BROKER: () =>
                  Response.json({
                    access_token: "ghs_integration_token",
                    expires_in: 300,
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    scope: "issues:write",
                    token_type: "Bearer",
                  }),
                WORKLOAD_IDENTITY_ISSUER: {
                  entrypoint: "WorkloadIdentityIssuer",
                  name: "workload-identity-issuer-local",
                },
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/cyspbot-github-webhook-processor/wrangler.jsonc",
            },
          }),
        ],
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/github-webhook-processor.test.ts"],
          name: "github-webhook-processor-integration",
        },
      },
    ],
  },
});
