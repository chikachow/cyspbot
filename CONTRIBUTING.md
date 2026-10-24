# Contributing

Keep changes cohesive, explicit, and grounded in the service contract.
[AGENTS.md](AGENTS.md) owns repository agent guidance; this document owns
validation scope and contribution requirements. Personal agent configuration
is not a prerequisite. Tool versions and command definitions remain
authoritative in `package.json`, `.nvmrc`, and the lockfile. For dependency
setup and updates, follow [dependency tooling](#dependency-tooling).

## Validation scope

Use focused checks during implementation. Before declaring a change fully
verified or ready, or opening or updating a pull request, apply the matching gate:

- **Agent instructions or prose only:** review consistency, local links, and the
  final diff; run `pnpm exec oxfmt --check <changed-markdown-files>` with the
  pinned formatter and `git diff --check`. For instruction changes, walk through
  representative triggering, safe, and unrelated tasks. Label these as static
  walkthroughs unless actual agent trials were observed. Static walkthroughs
  suffice for straightforward instruction corrections. Use observed agent trials
  to resolve material disagreements about agent behavior and before claiming
  that wording improves behavior; limit claims to what the trials establish.
  A full install and application suite are not required solely for prose changes.
- **Code, configuration, dependencies, generated artifacts, or executable
  examples:** establish dependencies with `pnpm install --frozen-lockfile` and
  use Node 24 and the pinned pnpm to run the full `pnpm run check` and
  `pnpm run test:coverage`, plus focused checks that establish the changed behavior. A previously verified frozen installation may be reused while its
  dependency inputs remain unchanged. Focused checks do not replace the full
  final check. The aggregate check includes Worker deployment dry runs; it does
  not deploy.

For runtime behavior or binding configuration changes, cover the affected unit and real Worker
entrypoint projects described in [Tests and validation](docs/implementation.md#tests-and-validation).
For changes to authentication, token exchange, permissions, queue processing, or logging
behavior, verify affected success and failure paths against [SECURITY.md](SECURITY.md)
and the [service contract](docs/service-contract.md). After implementing such
changes, perform a distinct adversarial review of the affected trust and
lifecycle boundaries, with depth proportionate to the changed guarantees.
The implementing agent may perform this pass for smaller changes. Consequential
changes to who can obtain authority, what can trigger external effects, or
whether accepted work can be lost require an independent reviewer.

A separate agent, even using the same model, qualifies when it assesses the
requirements, final diff, relevant source, and tests without being led by the
implementer's conclusions. Report the review's actual scope and limitations;
this provides a separate assessment, not model diversity or human approval.
Resolve actionable in-scope findings and rerun affected checks before readiness.
If required independent review is unavailable, complete other authorized work
and report verification as incomplete, identifying the missing review and what
would satisfy it. Self-review does not substitute for that gate.

Once appropriate checks pass, broaden or repeat them only for new changes,
failures, or unresolved concerns. Report exact commands and distinguish passed,
failed, and unrun checks. Separate environmental failures from source defects;
try reasonable safe scoped alternatives. An unavailable required check leaves
verification incomplete even if implementation is finished; report the missing
check and what would allow it to run.
Local checks do not establish remote CI success or waive required CI checks.

For deployment changes, follow [Deployment](docs/deployment.md), including the
separate deployment repository's validation. Publishing or releasing still
requires the [source publishing requirements](#source-publishing), including
the full check and coverage gates.

## Documentation ownership

Before handoff, update the authoritative document for each affected concern:

- [Service contract](docs/service-contract.md) for externally observable behavior.
- [Implementation](docs/implementation.md) for package layout, Worker entrypoints, request flow, bindings, and test boundaries.
- [Deployment](docs/deployment.md) for source/deployment ownership and this document for publish-readiness checks.
- [CONTEXT.md](CONTEXT.md) for terminology and [SECURITY.md](SECURITY.md) for security policy.

Resolve discrepancies among source, tests, and contracts before encoding new
guidance. Use present-tense documentation for implemented behavior.

## Public source boundary

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, Cloudflare tokens, and webhook secrets out of commits.

## Source publishing

Use Node 24 and the pinned pnpm to run `pnpm run check` and
`pnpm run test:coverage` before publishing source artifacts.

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
