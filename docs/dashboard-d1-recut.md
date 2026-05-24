# Dashboard And Persistence Re-cut

This document is the source of truth for the planned replacement of the current dashboard prototype and Audit Log persistence model.

## Status

- The currently checked-in dashboard and Dashboard Session implementation is a prototype and is not the target architecture.
- The target architecture moves the durable Audit Log, Dashboard Sessions, installation projection, and Repository Visibility Cache into D1.
- `GitHubInstallationObject` remains, but only as the installation-scoped Installation Coordinator for signal coalescing and serialized Installation Reconciliation.

## Goals

- Keep GitHub as the authority for dashboard repository visibility and GitHub App installation access token issuance.
- Make D1 the durable system of record for Dashboard Sessions, the Repository Visibility Cache, and the Audit Log.
- Preserve GitHub App Installation isolation by keeping one `GitHubInstallationObject` per installation for Installation Reconciliation signal coalescing and serialized execution.
- Remove split durable authority between installation-scoped Durable Objects and global query surfaces.
- Keep Token Minting live against GitHub for installation lookup and repository metadata evaluation.

## Route shape

### Token Minting and verification

- `POST /token`
- `POST /github/claims`
- `POST /github/installations/token`

These continue to authenticate GitHub Actions OIDC Callers and use live GitHub API reads during Token Minting.

### Dashboard authentication

- `GET /login/github`
- `GET /auth/github/callback`
- `GET /logout`

These routes manage GitHub App user authorization and the local Cyspbot Dashboard Session lifecycle.

### Dashboard

- `GET /dashboard`
- `GET /dashboard/repositories/:owner/:name`

Behavior:

- `/dashboard` requires authentication and redirects to `/login/github` when unauthenticated.
- Repository URLs are user-facing and use current `owner/name`.
- Route resolution is always by current projection row first, then by immutable `repository_id` internally.
- Route resolution is case-insensitive and uses normalized `owner/name` values for lookup, while preserving current GitHub casing for display.
- If a current `owner/name` does not resolve, return `404`.
- If the repo resolves but the user is not authorized after one cache refresh attempt, return `404`.

## Authority boundaries

### GitHub remains authoritative for

- GitHub Actions OIDC caller identity
- GitHub App Installation presence during Token Minting
- repository metadata used for Token Policy evaluation during Token Minting
- Dashboard User visibility through:
  - `GET /user/installations`
  - `GET /user/installations/{installation_id}/repositories`

### D1 is authoritative for

- Audit Log persistence
- issued-token detail persistence
- current installation/repository/membership projection
- Dashboard Sessions
- Repository Visibility Cache rows
- Installation Reconciliation status
- Webhook Delivery Log metadata

Naming rule:

- D1 tables use plural names because they are relational collections.
- D1 columns stay singular and local to their table context.
- D1 table names use Cyspbot domain concepts rather than endpoint mechanics: for example `token_mint_audit_entries`, not `github_token_requests`.
- Normalized identity, lookup, join, route, and uniqueness values use `_normalized` when the source has display casing or other non-canonical spelling.
- Display-only GitHub spelling snapshots use `_display` and must not be used for authorization, joins, route resolution, or uniqueness.
- OIDC claim-derived Audit Log columns use the `oidc_` prefix; GitHub and GitHub Actions claim-derived columns use `github_` or `git_` prefixes.
- Durable Object local singleton state uses key-value storage rather than local SQL tables unless a real relational need appears later.

### `GitHubInstallationObject` is authoritative only for

- installation-local Installation Reconciliation signal coalescing
- installation-local serialized Installation Reconciliation execution
- minimal installation-local coordination state

It is not authoritative for the Audit Log, repository projection, the Repository Visibility Cache, or Dashboard Sessions.

## D1 schema

All timestamps are stored as UTC ISO 8601 strings.

All booleans are stored as `INTEGER NOT NULL CHECK (<column> IN (0, 1))`.

All tables should be created with foreign keys enabled.

### Dashboard Users

```sql
CREATE TABLE dashboard_users (
  github_user_id TEXT PRIMARY KEY,
  github_login_display TEXT NOT NULL,
  last_github_auth_at TEXT NOT NULL,
  session_revoked_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Notes:

- `github_user_id` is the immutable identity key.
- `github_login_display` is mutable display metadata only and must not be used as an identity key.

### Dashboard Sessions

```sql
CREATE TABLE dashboard_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token_hash TEXT NOT NULL UNIQUE,
  github_user_id TEXT NOT NULL,
  encrypted_github_user_token_blob TEXT NOT NULL,
  github_user_access_token_expires_at TEXT,
  github_user_refresh_token_expires_at TEXT,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (github_user_id) REFERENCES dashboard_users(github_user_id) ON DELETE CASCADE
);

CREATE INDEX dashboard_sessions_by_user_id ON dashboard_sessions(github_user_id);
CREATE INDEX dashboard_sessions_by_idle_expires_at ON dashboard_sessions(idle_expires_at);
CREATE INDEX dashboard_sessions_by_absolute_expires_at ON dashboard_sessions(absolute_expires_at);
```

Notes:

- Browser cookie holds the raw opaque session token.
- D1 stores only `session_token_hash`, computed as `HMAC-SHA-256(session_lookup_secret, raw_session_token)`.
- `encrypted_github_user_token_blob` stores the GitHub User Access Token and refresh token together under a separate encryption secret.
- Expiry timestamps stay plaintext for cheap refresh and purge decisions.
- Session cookies must be `HttpOnly`, `Secure`, and `SameSite=Lax`.
- The cookie `Max-Age` must not exceed the server-side absolute session TTL.
- Session ids are rotated on successful login and on any flow that replaces token material after refresh.
- The encrypted token blob format must carry a key version so encryption-key rotation is possible without ambiguous decrypt behavior.

### GitHub App Installations

```sql
CREATE TABLE github_app_installations (
  installation_id INTEGER PRIMARY KEY,
  github_account_id TEXT,
  github_account_login_display TEXT,
  github_account_type TEXT,
  repository_selection TEXT NOT NULL,
  suspended_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### GitHub Repositories

```sql
CREATE TABLE github_repositories (
  repository_id INTEGER PRIMARY KEY,
  owner_login_display TEXT NOT NULL,
  repository_name_display TEXT NOT NULL,
  full_name_display TEXT NOT NULL,
  full_name_normalized TEXT NOT NULL,
  github_owner_id TEXT,
  repository_visibility TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX github_repositories_active_full_name_normalized
  ON github_repositories(full_name_normalized)
  WHERE deleted_at IS NULL;

CREATE INDEX github_repositories_by_archived_at ON github_repositories(archived_at);
CREATE INDEX github_repositories_by_deleted_at ON github_repositories(deleted_at);
```

Notes:

- `repository_id` is the immutable repository identity.
- `owner_login_display`, `repository_name_display`, and `full_name_display` are current GitHub display metadata and may change on rename or transfer.
- `full_name_normalized` is lowercased `owner/name` used for routing and uniqueness.
- Display metadata columns must not be used for authorization, joins, route resolution, or uniqueness.
- Soft-deleted rows are retained for a finite window.

### GitHub App Installation Repositories

```sql
CREATE TABLE github_app_installation_repositories (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id),
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES github_repositories(repository_id) ON DELETE CASCADE
);

CREATE INDEX github_app_installation_repositories_by_repository_id
  ON github_app_installation_repositories(repository_id);
```

Notes:

- This is current-state projection only.
- Membership edges are hard-deleted immediately when Installation Reconciliation removes them.

### Repository Visibility Cache

```sql
CREATE TABLE repository_visibility_cache_entries (
  github_user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  github_repository_permissions_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (github_user_id, installation_id, repository_id),
  FOREIGN KEY (github_user_id) REFERENCES dashboard_users(github_user_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES github_repositories(repository_id) ON DELETE CASCADE
);

CREATE INDEX repository_visibility_cache_entries_by_expiry
  ON repository_visibility_cache_entries(expires_at);

CREATE INDEX repository_visibility_cache_entries_by_user_repo
  ON repository_visibility_cache_entries(github_user_id, repository_id);
```

Notes:

- This is a derived cache, not an entitlement store.
- Visibility Refresh may upsert the `github_app_installations`, `github_repositories`, and `github_app_installation_repositories` rows needed for the GitHub-returned positive visibility rows before replacing the cache slice.
- Those upserts are bootstrapping writes from GitHub's user-to-server installation repository API response; they must not delete repositories, delete installation membership edges, mark repositories or installations as deleted, or infer visibility for repositories GitHub did not return for the user.
- Installation Reconciliation remains the only writer that performs full installation-slice replacement, deletion, suspension, or removal decisions.
- Cache refresh replaces the full `user + installation` slice atomically.

### Audit Log

```sql
CREATE TABLE token_mint_audit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at TEXT NOT NULL,
  audit_state TEXT NOT NULL CHECK (audit_state IN ('pending', 'finalized', 'finalization_failed')),
  finalized_at TEXT,
  installation_id INTEGER,
  caller_repository_id INTEGER NOT NULL,
  caller_repository_full_name_normalized TEXT NOT NULL,
  caller_repository_full_name_display TEXT NOT NULL,
  caller_repository_owner_id TEXT NOT NULL,
  caller_repository_visibility TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  oidc_issuer TEXT NOT NULL,
  oidc_resolved_key_id TEXT,
  github_actions_event_name TEXT NOT NULL,
  github_ref TEXT,
  github_ref_type TEXT,
  github_workflow_ref TEXT,
  github_job_workflow_ref TEXT,
  github_run_id TEXT,
  github_run_attempt TEXT,
  git_sha TEXT,
  github_actor TEXT,
  outcome TEXT CHECK (outcome IN ('issued', 'denied', 'upstream_error', 'internal_error'))
);

CREATE INDEX token_mint_audit_entries_by_caller_repository_requested_at
  ON token_mint_audit_entries(caller_repository_id, requested_at DESC, id DESC);

CREATE INDEX token_mint_audit_entries_by_installation_requested_at
  ON token_mint_audit_entries(installation_id, requested_at DESC, id DESC);

CREATE INDEX token_mint_audit_entries_by_requested_at
  ON token_mint_audit_entries(requested_at);
```

Notes:

- This is the required durable Audit Log record for Token Minting.
- `caller_repository_id`, `caller_repository_full_name_normalized`, `caller_repository_owner_id`, and `caller_repository_visibility` are the normalized GitHub-issued OIDC Caller context, captured before live GitHub lookup.
- `caller_repository_full_name_display` is the original GitHub repository claim spelling captured for audit display only. It must not be used for lookup, joins, authorization, or uniqueness.
- OIDC claim-derived columns are prefixed with `oidc_`, GitHub Actions claim-derived columns are prefixed with `github_` or `git_`, and Cyspbot outcome columns are unprefixed.
- `installation_id` is nullable because GitHub App Installation lookup can fail after Caller authentication but before the installation is known.
- A durable `pending` audit-intent row is written after OIDC authentication produces normalized Caller context and before any GitHub App Installation or repository lookup.
- The row is finalized to the terminal outcome in a second write after live GitHub lookup, policy evaluation, and, when applicable, after GitHub responds to the GitHub access-token request.
- Live GitHub lookup failures after caller authentication are finalized as `upstream_error` or `denied`, with reason rows that identify the failed stage.
- Terminal audit finalization and child-row writes must be one D1 transaction where D1 supports the required statement set.
- Token Minting must fail closed if the finalization write cannot be persisted.
- If GitHub minted a token but terminal finalization fails, Cyspbot still returns a server error.
- A durable `finalization_failed` row is only guaranteed when Cyspbot can persist the failure marker after a partial terminal-write failure.
- If D1 is unavailable and the failure marker cannot be persisted, the original `pending` intent row is the durable gap record and the runtime must emit an operational error suitable for alerting.
- Pre-authentication failures that never produce normalized Caller context stay in operational logs, not this table.
- Audit Log rows intentionally do not foreign-key to current projection tables because audit durability must not depend on Installation Reconciliation timing or projection retention.

### Audit outcome reasons

```sql
CREATE TABLE token_mint_audit_outcome_reasons (
  audit_log_entry_id INTEGER NOT NULL,
  outcome_reason TEXT NOT NULL,
  PRIMARY KEY (audit_log_entry_id, outcome_reason),
  FOREIGN KEY (audit_log_entry_id) REFERENCES token_mint_audit_entries(id) ON DELETE CASCADE
);
```

Notes:

- Populated for `outcome = 'denied'`, and for `upstream_error` or `internal_error` when a stable reason code is available.
- Policy denials use the same table as lookup and finalization-stage failures so audit consumers do not need a second reason model.

### Issued token facts

```sql
CREATE TABLE issued_installation_tokens (
  audit_log_entry_id INTEGER PRIMARY KEY,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (audit_log_entry_id) REFERENCES token_mint_audit_entries(id) ON DELETE CASCADE
);

CREATE INDEX issued_installation_tokens_by_expires_at ON issued_installation_tokens(expires_at);
```

Notes:

- `issued_installation_tokens` is a strict 0-or-1 child of `token_mint_audit_entries`.
- Request-level audit facts are enough; no extra issued-token fingerprint is stored in the first cut.

### Issued token permissions

```sql
CREATE TABLE issued_installation_token_permissions (
  audit_log_entry_id INTEGER NOT NULL,
  permission_name TEXT NOT NULL,
  permission_access TEXT NOT NULL,
  PRIMARY KEY (audit_log_entry_id, permission_name),
  FOREIGN KEY (audit_log_entry_id) REFERENCES issued_installation_tokens(audit_log_entry_id) ON DELETE CASCADE
);
```

Notes:

- Store the permissions exactly as GitHub returned them.
- `permission_name` and `permission_access` mirror GitHub's permission map entries without implying Cyspbot chose the permission set.

### Installation Reconciliation Status

```sql
CREATE TABLE installation_reconciliation_statuses (
  installation_id INTEGER PRIMARY KEY,
  reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN ('idle', 'pending', 'running', 'failed')),
  reconciliation_requested INTEGER NOT NULL CHECK (reconciliation_requested IN (0, 1)),
  reconciliation_running INTEGER NOT NULL CHECK (reconciliation_running IN (0, 1)),
  last_requested_at TEXT,
  last_started_at TEXT,
  last_succeeded_at TEXT,
  last_failed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_run_token TEXT,
  current_run_lease_expires_at TEXT,
  next_retry_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id) ON DELETE CASCADE
);

CREATE INDEX installation_reconciliation_statuses_by_status_next_retry
  ON installation_reconciliation_statuses(reconciliation_status, next_retry_at);
```

Notes:

- `attempt_count` counts consecutive failures since the last success.
- `reconciliation_status` is a compact current-state enum, not a history stream.
- This table is durable operational state, not installation identity.
- `current_run_token` and `current_run_lease_expires_at` provide crash recovery for wedged or lost in-flight DO execution.

### Webhook Delivery Log

```sql
CREATE TABLE webhook_delivery_log_entries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  github_event TEXT NOT NULL,
  installation_id INTEGER,
  delivery_accepted INTEGER NOT NULL CHECK (delivery_accepted IN (0, 1)),
  webhook_signature_valid INTEGER NOT NULL CHECK (webhook_signature_valid IN (0, 1)),
  response_status_code INTEGER NOT NULL,
  delivery_metadata_json TEXT,
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id)
);

CREATE INDEX webhook_delivery_log_entries_by_received_at
  ON webhook_delivery_log_entries(received_at);

CREATE INDEX webhook_delivery_log_entries_by_installation_received_at
  ON webhook_delivery_log_entries(installation_id, received_at DESC);
```

Notes:

- Store metadata only in the first cut, not raw webhook bodies.
- Persist one metadata row for each webhook delivery that reaches envelope validation, whether it is accepted or rejected.
- Do not keep a DO-only webhook log; D1 is the durable Webhook Delivery Log surface.

## Durable Object storage shapes

### `GitHubInstallationObject`

This Durable Object remains in the system, but only as the installation-scoped Installation Coordinator.

It persists only minimal reconstructable coordination state in Durable Object key-value storage.

Suggested local state shape:

```ts
interface InstallationReconcileState {
  reconcileRequested: boolean;
  reconcileRunning: boolean;
  currentRunToken?: string;
  lastSignalAt?: string;
}
```

Semantics:

- exactly one logical local state object
- `reconcileRequested = true` means at least one reconcile signal has been latched
- `reconcileRunning = true` means a pass is currently executing
- `currentRunToken` mirrors the D1 lease owner token for the currently running pass when present
- `lastSignalAt` is optional local observability only

Not stored here:

- Audit Log
- repository projection
- Repository Visibility Cache
- Dashboard Sessions
- durable retry counters or error state already recorded in D1

### `OidcIssuerVerifierObject`

No change is planned to the issuer verifier architecture in this re-cut.

Current logical storage uses one persisted verifier-state blob in Durable Object key-value storage:

- key: `verifier_state`
- value contains:
  - normalized JWKS snapshot
  - registration fingerprint
  - refresh backoff state

This remains separate from the dashboard and persistence redesign.

## Query and authorization behavior

### Dashboard list

Source:

- current repositories from `github_repositories`
- joined to positive `repository_visibility_cache_entries` rows
- joined to current Audit Log summary derived from `token_mint_audit_entries`

Rules:

- show all currently visible repositories, even if they have zero Audit Log history
- active repositories first
- archived repositories in a separate section at the bottom
- within each section:
  - repositories with history sort by `last_token_mint_at DESC`
  - repositories without history sort by `full_name_display ASC`
- use current projection `full_name_display` for display

Suggested summary projection strategy:

- either compute on read from `token_mint_audit_entries`
- or maintain a cheap SQL-side summary column/materialized projection later

The first cut does not require a separate summary table.

### Dashboard details

Route:

- `/dashboard/repositories/:owner/:name`

Resolution:

1. resolve current repository projection by current `owner/name`
2. if none exists, return `404`
3. check the fresh Repository Visibility Cache by `github_user_id + repository_id`
4. on missing or expired cache, refresh the relevant installation slice once
5. if the refresh fails, return `503`
6. if still unauthorized, return `404`
7. query last 5 `token_mint_audit_entries` rows by `caller_repository_id`
8. left join optional `issued_installation_tokens` and `issued_installation_token_permissions`

UI behavior:

- header shows current repository name from projection
- rows show request-level facts first
- `issued` rows inline `expires_at` and compact permissions summary
- if historical `caller_repository_full_name_display` differs from current `full_name_display`, show a small “recorded as …” note on that row
- `installation_id` is secondary row metadata only

### Stale visibility handling

Rules:

- cache freshness TTL: `5 minutes`
- expired Repository Visibility Cache rows do not authorize repository detail access.
- repository detail requests must refresh expired or missing visibility against GitHub before showing audit data.
- if GitHub refresh fails for a repository detail request, return `503 Service Unavailable`.
- if GitHub refresh succeeds and the repository is not returned for the user, return `404`.
- stale negative is never authoritative
- `/dashboard` may render stale repository names only as degraded navigation context when GitHub refresh fails.
- stale `/dashboard` rendering must not include audit summaries or enabled repository-detail links.
- repository audit data is shown only after fresh GitHub-backed authorization.
- when a visibility refresh fails, record an operational event with `github_user_id`, `installation_id` when known, `repository_id` when relevant, error class, and whether stale list context was rendered.

## Token Minting

Token Minting remains live against GitHub:

- write a durable Audit Log intent row to D1 after OIDC authentication and caller-context normalization
- resolve installation live from GitHub
- resolve repository metadata live from GitHub
- evaluate token policy against live metadata
- mint token live from GitHub
- finalize `token_mint_audit_entries` and any child rows in D1
- if the finalization write fails, return a server error even if GitHub already minted the token

Token Minting does not update installation or repository projection opportunistically.

Auth and redirect controls:

- `/login/github` creates and stores an OAuth `state` value server-side or in a signed short-lived state cookie before redirecting to GitHub.
- `/auth/github/callback` must validate the returned `state` before exchanging the code.
- Return targets are validated against an explicit allowlist of dashboard route shapes:
  - `/dashboard`
  - `/dashboard/repositories/:owner/:name`
- Any invalid or unrecognized return target is normalized to `/dashboard`.

## Reconciliation flow

### Writer ownership

- Token Minting writes only Audit Log tables
- Dashboard authentication and Visibility Refresh write:
  - `dashboard_users`
  - `dashboard_sessions`
  - positive projection bootstrap rows for GitHub-returned visible repositories only
  - `repository_visibility_cache_entries`
- Installation Reconciliation writes:
  - `github_app_installations`
  - `github_repositories`
  - `github_app_installation_repositories`
  - `installation_reconciliation_statuses`
  - `webhook_delivery_log_entries`

### Execution model

1. webhook or manual request signals Installation Reconciliation for one GitHub App Installation
2. signal goes through `GitHubInstallationObject`
3. DO latches `reconciliation_requested = 1`
4. DO executes one Installation Reconciliation pass if not already running
5. DO acquires or refreshes a D1-backed run lease by writing `current_run_token` and `current_run_lease_expires_at`
6. Installation Reconciliation fetches the authoritative installation snapshot from GitHub
7. if the snapshot is complete, replace/update installation projection atomically in D1
8. on success:
   - update `installation_reconciliation_statuses`
   - clear `reconciliation_requested` unless another signal arrived while running
9. on failure:
   - update `installation_reconciliation_statuses` with failure and backoff data
   - clear `reconciliation_running`
   - leave `reconciliation_requested = 1`

Crash recovery rule:

- if the scheduler finds `reconciliation_status = 'running'` and `current_run_lease_expires_at` is in the past, it treats the run as lost, marks the installation back to `pending`, preserves `reconciliation_requested = 1`, records a timeout-style failure code, and re-pokes the installation DO

### Coalescing behavior

- repeated signals while idle collapse into one pending run
- if a signal arrives while running, perform exactly one more pass afterward

### Retry model

- scheduled Worker scans D1 for installations whose Installation Reconciliation retry is due
- it pokes the corresponding `GitHubInstallationObject`
- the DO is the sole per-installation executor

### Atomicity rule

- installation projection replacement is atomic per installation
- do not partially replace `github_app_installation_repositories`
- if GitHub fetch is incomplete or inconsistent, leave previous projection intact
- installation-scoped route normalization and projection uniqueness must use the normalized full-name key, not raw display casing

## Retention and cleanup

- `token_mint_audit_entries` and all child rows: `180 days`
- soft-deleted `github_repositories`: `180 days`
- soft-deleted `github_app_installations`: `180 days`
- `dashboard_sessions`:
  - invalidated sessions: delete immediately
  - expired sessions: purge within `24 hours`
- `repository_visibility_cache_entries`: purge expired Repository Visibility Cache rows within `24 hours`
- successful Installation Reconciliation status rows: keep `7 days` after last success if fully idle
- failed Installation Reconciliation status rows: keep `30 days`
- `webhook_delivery_log_entries`: `7 days`

Cleanup should run from a scheduled Worker job, not only opportunistically on reads.

## Rollout sequence

### Phase 0: docs and naming freeze

- land this document
- align README, ADRs, CONTEXT, and PRD references
- freeze route names, table names, and retention policy before schema work begins

### Phase 1: D1 bootstrap

- add D1 binding and migrations
- create D1 schema for:
  - `dashboard_users`
  - `dashboard_sessions`
  - `token_mint_audit_entries`
  - `issued_installation_tokens`
  - `issued_installation_token_permissions`
  - `token_mint_audit_outcome_reasons`

This phase makes the central Audit Log and SQL-backed Dashboard Sessions possible before the dashboard rewrite.

### Phase 2: Token Minting audit cutover

- write Audit Log records to D1
- make audit persistence mandatory for mint success
- stop treating installation DO audit storage as authoritative

At the end of this phase:

- D1 is the system of record for the Audit Log
- installation DO audit code is either removed or left as compatibility scaffolding pending deletion

### Phase 3: Dashboard authentication cutover

- move auth routes to:
  - `/login/github`
  - `/auth/github/callback`
  - `/logout`
- store Dashboard Sessions in D1
- hash public session tokens with HMAC
- encrypt GitHub user token blobs in D1
- remove `DashboardSessionObject`

### Phase 4: projection and Repository Visibility Cache

- add:
  - `github_app_installations`
  - `github_repositories`
  - `github_app_installation_repositories`
  - `repository_visibility_cache_entries`
  - `installation_reconciliation_statuses`
  - `webhook_delivery_log_entries`
- implement login-driven and on-demand Visibility Refresh
- keep Token Minting live against GitHub

### Phase 5: dashboard rewrite

- rebuild `/dashboard`
- rebuild `/dashboard/repositories/:owner/:name`
- authorize by projection + Repository Visibility Cache
- add fail-closed repository detail authorization and degraded stale list context for GitHub-unavailable cases
- remove any repository-id route shape from the prototype

### Phase 6: Installation Reconciliation executor cutover

- narrow `GitHubInstallationObject` to Installation Reconciliation coalescing and serialized execution only
- route webhook and manual Installation Reconciliation signals through the DO
- write Installation Reconciliation outcomes to D1
- write webhook delivery metadata to D1
- add scheduled retry dispatcher

### Phase 7: cleanup and deletion of obsolete prototype paths

- remove installation-local Audit Log persistence
- remove prototype dashboard and Dashboard Session code paths
- add cleanup jobs for Dashboard Sessions, Repository Visibility Cache, Audit Log retention, Installation Reconciliation state, and Webhook Delivery Log rows

### Phase 8: optional follow-ups

- add repository list summary projection if query cost requires it
- add operator diagnostics UI or reports for Installation Reconciliation failures
- add future permission-intersection Audit Log fields only when that feature actually exists

## Review checklist

- Are D1 tables scoped correctly between durable facts and derived cache state?
- Is the installation DO narrow enough to preserve isolation without becoming a second source of truth?
- Are the route semantics acceptable for rename/transfer breakage under current-name-only URLs?
- Is Token Minting still strict enough about live GitHub authority and mandatory audit durability?
- Is the rollout order small enough to land without leaving two long-lived competing architectures?
