# Cloudflare Vitest 5 compatibility

`@cloudflare__vitest-plugin@1.1.5.patch` ports the runtime changes from
[Cloudflare PR #15500](https://github.com/cloudflare/workers-sdk/pull/15500), pinned
to commit [`7b89dc48f3f4b0dfba5df352bcbdf8e2cbcff30e`](https://github.com/cloudflare/workers-sdk/commit/7b89dc48f3f4b0dfba5df352bcbdf8e2cbcff30e),
onto the published plugin's JavaScript bundles. That upstream change is not yet
released. This patch preserves the published Wrangler and Miniflare dependencies.

The patch preserves the quoted `import.meta.url` diagnostic in Vitest 5's module
evaluator, forwards Istanbul coverage writes from Workerd to the Node test host,
and enables WeakRef support when the test compatibility flags require it. It also
updates the manifest that the plugin reads for its runtime version check. The
three version-specific pnpm overrides apply the same peer contract during
dependency resolution; pnpm patches alone do not update dependency resolution.

The coverage bridge is part of the local test runner. Like the plugin's existing
snapshot bridge, it accepts host filesystem paths from trusted test code. It is
not a sandbox for untrusted tests and is not bundled into production Workers.

Remove the patch, its `patchedDependencies` entry, and all three related overrides
when adopting a published Cloudflare plugin with Vitest 5 support. Regenerate the
lockfile and run a frozen install, `node --run check`, and
`node --run test:coverage`. Verify that coverage still records executed source
and includes unimported source at zero coverage. Keep patch failures and unused
patches as installation errors so a plugin update requires this review.
