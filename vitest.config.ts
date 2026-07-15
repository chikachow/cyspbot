import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
    coverage: {
      exclude: ["**/*.test.ts", "test/**", "worker-configuration.d.ts"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
    },
    detectAsyncLeaks: true,
    fileParallelism: false,
  },
});
