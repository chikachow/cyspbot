# Public Release Checklist

Run this checklist before making the repository public or tagging a release.

## Source Tree

- `git status --short` shows only intentional changes.
- `git status --short --ignored` has been reviewed for ignored local files that must not be packaged.
- Release artifacts are built from tracked files, for example from `git archive` or another explicit allowlist based on `git ls-files`.
- No local `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private keys, generated state, or dependency directories are included in release artifacts.
- `git ls-files` contains no private keys, tokens, local absolute paths, Cloudflare account IDs, API tokens, or secret values.
- `node --run check` passes.

## Documentation

- `README.md` describes the current source repository and deployment boundary.
- `docs/service-contract.md` matches implemented behaviour.
- `docs/implementation.md` matches the workspace packages, Worker entrypoints, bindings, and verification commands.
- `docs/deployment.md` describes only the source repository boundary, including the sole Node-only test fixture seam intentionally consumed by the separate deployment repository, and does not publish deployment details.
- Checked-in OIDC Provider Registrations match the intended production trust set; any authentication-only registration is intentional and documented.
- Checked-in Token Issuance Policy Permit Statements match the intended production authorization set, and every referenced issuer has a Provider Registration.
- No dynamic issuer-trust or authorization-policy binding has been introduced.
- Deployment overlays do not override source-owned issuer trust or
  authorization policy and preserve deployment-owned routes, identifiers, rate
  limits, and secret bindings.
- `CONTEXT.md` remains the glossary source of truth.
- Deployment remains outside this codebase.

## Repository Settings

Enable these settings after publication:

- GitHub secret scanning
- secret scanning push protection
- Dependabot security updates
- required `ci` check on protected branches
- private vulnerability reporting, if available

## Operational Secrets

Rotate any secret that has ever been committed or copied into an artifact that may become public. Do not rely on `.gitignore` as evidence that a secret was never exposed.

If a local private key, token, `.dev.vars`, `.env`, or generated Wrangler state exists in the working tree during publication, treat it as an artifact-packaging risk even when Git ignores it.
