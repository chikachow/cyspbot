# Contributing

Keep changes small, explicit, and grounded in the service contract.

Dependency updates permit intermediate peer conflicts while grouped updates are
assembled. `autoInstallPeers: false` keeps required peers explicit. The
`peer-dependencies:check` command re-runs resolution with strict peer validation
and lifecycle scripts disabled; a frozen install alone does not perform this
check. `dedupe:check` rejects avoidable lockfile duplication. Both checks run in
`check` and the required CI dependency job, alongside frozen manifest/lockfile
validation. CI also rejects any lockfile changes produced by validation.

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
