# Host Cyspbot as a GitHub Actions Security Token Service on Cloudflare Workers

Note:
The original Audit Log persistence details in this ADR have been superseded by the D1-backed re-cut documented in [0003-dashboard-user-authorization.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/adr/0003-dashboard-user-authorization.md) and [docs/dashboard-d1-recut.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/dashboard-d1-recut.md). This ADR still captures the core product decision to host Cyspbot on Workers and keep Token Minting live against GitHub.

Cyspbot will be a Cloudflare Worker that acts as a Security Token Service for GitHub Actions workflows. It authenticates Callers with GitHub Actions OIDC, authorizes repositories by GitHub App Installation, evaluates verified GitHub OIDC claims through checked-in Token Policy code, and exchanges trusted OIDC tokens for repository-scoped GitHub App installation access tokens. Repository permissions on minted tokens are governed by the GitHub App configuration rather than a server-side fixed permission profile. The primary minting contract uses an OAuth 2.0 token endpoint shape aligned with RFC 8693 token exchange, while a legacy GitHub-specific path remains in place for compatibility. We chose this over direct `actions/create-github-app-token` usage so the GitHub App private key stays inside Cloudflare Secrets Store and Token Minting stays under Cyspbot-owned policy and operational control.

## Considered Options

- Plain Worker with no Durable Object
- Worker plus per-installation Durable Object
- Cyspbot-side repository allowlist in addition to GitHub App Installation
- Caller-selected permission profiles

## Consequences

- Only GitHub Actions workflows with valid OIDC tokens may call Cyspbot.
- GitHub App Installation is repository authorization; there is no second Cyspbot registry in v1.
- `/github/claims` verifies caller identity and app-installation relationship, but does not evaluate full mintability policy.
- `/token` is the primary Token Minting endpoint and currently only allows default-branch `ref` contexts for `schedule`, `workflow_dispatch`, and `push`.
- `/github/installations/token` remains as a compatibility endpoint over the same Token Policy.
- Issued tokens are never cached or reused by Cyspbot.
- The policy is intentionally implemented as plain code because the current rules are small, deterministic, and easier to review that way.
