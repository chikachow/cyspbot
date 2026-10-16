# Contributing

Keep changes small, explicit, and grounded in the service contract.

See [dependency tooling](#dependency-tooling) for the dependency update policy
and validation gates.

Before opening a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Use Node 24 and the pinned pnpm to run `pnpm run check` and `pnpm run test:coverage`.
3. Update `docs/service-contract.md` when externally observable behaviour changes.
4. Update `docs/implementation.md` when package layout, Worker entrypoints, request flow, or bindings change.
5. Update `docs/deployment.md` when source/deployment ownership changes and this file when publish-readiness checks change.
6. Update `CONTEXT.md` when terminology or trust-boundary language changes.

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, Cloudflare tokens, and webhook secrets out of commits.

Use present-tense documentation for implemented behaviour.

Before publishing source artifacts, review `git status --short` and ignored local
files. Build artifacts from tracked source only; exclude dependency directories,
local deployment state, and secrets. Confirm generated environment types cover
all three Workers and binding names match the source/deployment configuration.
See [deployment requirements](docs/deployment.md) for production authorization,
queue recovery, and coordinated Token Endpoint verification.

Repository maintainers keep secret scanning and push protection, Dependabot
security updates, and private vulnerability reporting (where available) enabled.
The protected branch requires the aggregate `ci` check.

## Dependency tooling

Use Node 24 and the exact pnpm version in `packageManager`. Install it from the
repository root, then verify it before installing dependencies. When migrating
an existing Corepack installation, run `corepack disable pnpm` once first to
remove its pnpm shims.

```bash
npm install --global "$(node -p 'require("./package.json").packageManager')"
node --run pnpm:check
pnpm install --frozen-lockfile
```

CI installs the manifest pin with `pnpm/action-setup`. The local `check` command
retains the version guard for developer environments. `pmOnFail: ignore` keeps
the lockfile as one YAML document for GitHub's dependency graph; direct pnpm commands do not automatically select or enforce the
pin. Adding config dependencies requires reviewing that compatibility assumption.

Dependency updates permit intermediate peer conflicts while grouped updates are
assembled. `autoInstallPeers: false` keeps required peers explicit. The
`peer-dependencies:check` command runs `pnpm peers check` without changing the
lockfile; a frozen install alone does not perform this check. `dedupe:check` rejects avoidable lockfile duplication. Both checks run in
`check` and the required CI dependency job, alongside frozen manifest/lockfile
validation. CI also rejects any lockfile changes produced by validation.

The scheduled `pnpm-up` workflow updates pnpm to the latest stable release,
including new majors, using the same release-age policy. The step explicitly
forwards that policy because `self-update` ignores project release-age settings.
It overrides `pmOnFail` for this command so the manifest pin is updated. A changed
`packageManager` pin is committed before dependencies are updated with that
version; unchanged pins do not create empty commits.

`autoDedupe` consolidates compatible resolutions during updates, including across
workspace projects outside a command's filter. Frozen installs leave the graph
unchanged; `lockfile.includeResolutionSettings` records the selected deduplication
and linking settings.
`verifyDepsBeforeRun: error` stops pnpm scripts when dependencies are stale; it
does not guard `node --run`, so install explicitly before validation.

Dependency resolution uses a three-day release age, aligned with npm Dependabot
cooldown where configured. Frozen installs also verify lockfile supply-chain
policy. Dependency build scripts require explicit `allowBuilds` decisions;
`strictDepBuilds` rejects unreviewed builds.
