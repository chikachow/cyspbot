# Host a GitHub installation token broker on Cloudflare Workers

Cyspbot will be a Cloudflare Worker that brokers short-lived GitHub installation tokens for GitHub Actions workflows. It authenticates callers with GitHub Actions OIDC, authorizes repositories by GitHub App installation, mints repository-scoped installation tokens with one fixed permission set, and records bounded token-request audit history in a Durable Object keyed by GitHub App installation ID. We chose this over direct `actions/create-github-app-token` usage so the GitHub App private key stays inside Cloudflare Secrets Store, and over a plain stateless Worker so audit history has an installation-local persistence boundary without caching tokens.

## Considered Options

- Plain Worker with no Durable Object
- Worker plus per-installation Durable Object
- Broker-side repository allowlist in addition to GitHub App installation
- Caller-selected permission profiles

## Consequences

- Only GitHub Actions workflows with valid OIDC tokens may call the broker.
- Installation is repository authorization; there is no second broker registry in v1.
- `/github/claims` verifies caller identity and app-installation relationship, but does not evaluate full mintability policy.
- `/github/installations/token` only allows `schedule`, `workflow_dispatch`, and `push` on the current default branch.
- Issued tokens are never cached or reused by the broker.
