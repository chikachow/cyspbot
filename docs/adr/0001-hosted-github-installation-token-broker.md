# Host a GitHub installation token broker on Cloudflare Workers

Cyspbot will be a Cloudflare Worker that acts as a Security Token Service for GitHub Actions workflows. It authenticates callers with GitHub Actions OIDC, authorizes repositories by GitHub App installation, evaluates verified GitHub OIDC claims through checked-in policy code, exchanges trusted OIDC tokens for repository-scoped GitHub installation access tokens, and records bounded token-request audit history in a Durable Object keyed by GitHub App installation ID. Repository permissions on minted tokens are governed by the GitHub App configuration rather than a server-side fixed permission profile. The primary minting contract uses an OAuth 2.0 token endpoint shape aligned with RFC 8693 token exchange, while a legacy GitHub-specific path remains in place for compatibility. We chose this over direct `actions/create-github-app-token` usage so the GitHub App private key stays inside Cloudflare Secrets Store, and over a plain stateless Worker so audit history has an installation-local persistence boundary without caching tokens.

## Considered Options

- Plain Worker with no Durable Object
- Worker plus per-installation Durable Object
- Broker-side repository allowlist in addition to GitHub App installation
- Caller-selected permission profiles

## Consequences

- Only GitHub Actions workflows with valid OIDC tokens may call the broker.
- Installation is repository authorization; there is no second broker registry in v1.
- `/github/claims` verifies caller identity and app-installation relationship, but does not evaluate full mintability policy.
- `/token` is the primary minting endpoint and currently only allows default-branch `ref` contexts for `schedule`, `workflow_dispatch`, and `push`.
- `/github/installations/token` remains as a compatibility endpoint over the same minting policy.
- Issued tokens are never cached or reused by the broker.
- The policy is intentionally implemented as plain code because the current rules are small, deterministic, and easier to review that way.
