import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        environment: "test",
      },
    }),
  ],
  test: {
    coverage: {
      exclude: ["worker-configuration.d.ts"],
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
