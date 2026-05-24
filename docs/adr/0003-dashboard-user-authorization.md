# Add GitHub App user authorization with D1-backed Dashboard Sessions and visibility

cyspbot has a read-only dashboard for humans. It authenticates Dashboard Users through GitHub App user authorization, stores Dashboard Sessions in D1, stores the Audit Log centrally in D1, and keeps `GitHubInstallationObject` only as the Installation Coordinator for signal coalescing. We chose this over keeping Dashboard Session state and audit reads in separate Durable Objects because the dashboard needs repo-centric and cross-installation reads, centrally enforced retention, and one durable source of truth for the Audit Log, while still preserving installation isolation for future Installation Reconciliation execution.

## Considered Options

- Keep the prototype design with Dashboard Session state and audit reads in Durable Objects
- Move all dashboard and audit state to D1 and remove installation Durable Objects entirely
- Move durable facts to D1 while retaining one Installation Coordinator per GitHub App Installation as a narrow coordination/execution boundary

## Consequences

- Dashboard authentication is a second authentication surface and stays isolated from GitHub Actions OIDC Caller authentication.
- GitHub remains the authority for dashboard repository visibility through the user-to-server installation repository APIs.
- D1 is the durable system of record for:
  - Audit Log
  - issued Installation Token facts
  - Dashboard Sessions
  - Dashboard Users
  - Installation Reconciliation state and run history
  - Webhook Delivery Log metadata
- `GitHubInstallationObject` no longer owns the Audit Log; it only coalesces Installation Reconciliation signals in the current implementation. Serialized Installation Reconciliation execution is future implementation.
- Installation Token Issuance continues to resolve installation and repository metadata live from GitHub and fails closed if final Audit Log persistence to D1 fails.
- The dashboard uses user-facing repository URLs based on current `owner/name`, but resolves authorization and audit by immutable `repository_id` internally.
- GitHub App installation setup redirects are treated as onboarding entrypoints, not as dashboard OAuth login completions. The target GitHub App configuration sends setup redirects to `/github/setup`; cyspbot clears stale OAuth state and restarts `/login/github` from there.

The concrete schema, Durable Object storage model, current implementation state, and future implementation notes are documented in [docs/dashboard-d1-recut.md](/Users/STalbot@Scentregroup.com/src/cysp/cyspbot/docs/dashboard-d1-recut.md).
