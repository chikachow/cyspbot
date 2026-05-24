# Dashboard And Persistence Re-cut

This document is the source of truth for the D1-backed dashboard, Audit Log, Repository Visibility Cache, and Webhook Delivery Log implementation.

## Status

- The dashboard and Installation Token Issuance Audit Log have been cut over to D1.
- Dashboard Sessions are D1 rows addressed by an opaque `__Host-cyspbot_dashboard_session` cookie and HMAC lookup hash.
- `GitHubInstallationObject` remains only as the installation-scoped Installation Coordinator for signal coalescing and serialized Installation Reconciliation.
- The old Dashboard Session Durable Object, installation-local Audit Log tables, repository-id dashboard route, and Durable Object migration endpoint have been removed.

## Goals

- Keep GitHub as the authority for dashboard repository visibility and GitHub App installation access token issuance.
- Make D1 the durable system of record for Dashboard Sessions, the Repository Visibility Cache, and the Audit Log.
- Preserve GitHub App Installation isolation by keeping one `GitHubInstallationObject` per installation for Installation Reconciliation signal coalescing and serialized execution.
- Remove split durable authority between installation-scoped Durable Objects and global query surfaces.
- Keep Installation Token Issuance live against GitHub for installation lookup and repository metadata evaluation.

## Route shape

### Installation Token Issuance and verification

- `POST /token`
- `POST /github/claims`
- `POST /github/installations/token`

These continue to authenticate GitHub Actions OIDC Callers and use live GitHub API reads during Installation Token Issuance.

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
- GitHub App Installation presence during Installation Token Issuance
- repository metadata used for Token Policy evaluation during Installation Token Issuance
- Dashboard User visibility through:
  - `GET /user/installations`
  - `GET /user/installations/{installation_id}/repositories`

### D1 is authoritative for

- Audit Log persistence
- issued Installation Token detail persistence
- current installation/repository/membership projection
- Dashboard Sessions
- Repository Visibility Cache rows
- Installation Reconciliation state and run history
- Webhook Delivery Log metadata

Naming rule:

- D1 tables use plural names because they are relational collections.
- D1 columns stay singular and local to their table context.
- D1 table names use Cyspbot domain concepts rather than endpoint mechanics: for example `installation_token_issuance_audit_entries`, not `github_token_requests`.
- Normalized identity, lookup, join, route, and uniqueness values use `_normalized` when the source has display casing or other non-canonical spelling.
- Display-only GitHub spelling snapshots use `_display` and must not be used for authorization, joins, route resolution, or uniqueness.
- OIDC claim-derived Audit Log columns use the `oidc_` prefix; GitHub and GitHub Actions claim-derived columns use `github_` or `git_` prefixes.
- Durable Object local singleton state uses key-value storage rather than local SQL tables unless a real relational need appears later.

Table ownership guardrail:

| Table family                                                                                  | Data class                                         | Writer                                                                               | May authorize?                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `installation_token_issuance_audit_entries` and child rows                                    | Durable Audit Log facts                            | Installation Token Issuance                                                          | No                                            |
| `issued_installation_tokens` and child rows                                                   | Durable issued Installation Token facts            | Installation Token Issuance                                                          | No                                            |
| `dashboard_users` and `dashboard_sessions`                                                    | Durable Dashboard User and Dashboard Session state | Dashboard authentication                                                             | Yes, for dashboard authentication only        |
| `github_app_installations`, `github_repositories`, and `github_app_installation_repositories` | Current GitHub-derived installation projection     | Installation Reconciliation; positive bootstrap upserts from Visibility Refresh only | No, without fresh Repository Visibility Cache |
| `repository_visibility_cache_entries`                                                         | Derived, expiring Dashboard User visibility cache  | Visibility Refresh                                                                   | Yes, only while fresh                         |
| `installation_reconciliation_states` and `installation_reconciliation_runs`                   | Durable scheduler state and run history            | Installation Reconciliation executor and retry dispatcher                            | No                                            |
| `webhook_delivery_log_entries`                                                                | Durable operational metadata                       | Webhook Receiver                                                                     | No                                            |

### `GitHubInstallationObject` is authoritative only for

- installation-local Installation Reconciliation signal coalescing
- installation-local serialized Installation Reconciliation execution
- minimal installation-local coordination state

It is not authoritative for the Audit Log, repository projection, the Repository Visibility Cache, or Dashboard Sessions.
Its local state must be reconstructable from D1 plus a new incoming signal; no audit, projection, visibility, session, retry counter, or durable failure history may exist only inside the Durable Object.

## D1 schema

All timestamps are stored as UTC ISO 8601 strings.

All booleans are stored as `INTEGER NOT NULL CHECK (<column> IN (0, 1))`.

All tables should be created with foreign keys enabled.

Cross-cutting schema guardrails:

- Identity columns store the most immutable identifier available from GitHub. Mutable names and logins are display metadata or route locators only.
- Current projection tables may be corrected by GitHub reconciliation, but historical fact tables must remain stable evidence even when GitHub state changes later.
- Nullable columns must mean "not yet known", "not returned by GitHub", or "not applicable at this stage"; do not use `NULL` as a third business outcome when an explicit status or reason code is needed.
- JSON is avoided for queryable facts. Use child rows for repeated values that dashboard reads, retention jobs, or audit exports need to filter or summarize.
- Secret material is never stored raw. Hashes support lookup only; encrypted blobs support future decrypt-and-use flows only when a separate key version is present.
- Foreign keys are used for D1-owned lifecycle coupling, but not from durable audit facts to mutable projection rows.
- Every table that participates in time-based cleanup has either a direct expiry timestamp or a retention-driving timestamp with an index.
- A writer may add data only inside its owned table family unless this document explicitly allows a bootstrap write.

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
- `last_github_auth_at` is the last successful GitHub authorization time, not proof of current repository visibility.
- `session_revoked_after` supports user-wide session invalidation without scanning every session row during the revocation decision.
- `created_at` and `updated_at` are operational metadata for support and cleanup visibility; they must not drive repository authorization.
- Trade-off: the table intentionally stores no email, org membership, or profile JSON. That keeps the Dashboard User model narrow and avoids treating mutable GitHub profile data as authorization evidence.

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
- Dashboard Session cookie name: `__Host-cyspbot_dashboard_session`.
- Dashboard Session cookie path: `/`.
- Dashboard Session cookie must not set a `Domain` attribute.
- D1 stores only `session_token_hash`, computed as `HMAC-SHA-256(session_lookup_secret, raw_session_token)`.
- `encrypted_github_user_token_blob` stores GitHub User Access Token material under a separate encryption secret.
- The v1 dashboard does not store or use GitHub user refresh tokens. `github_user_refresh_token_expires_at` remains nullable for a future refresh-token flow.
- Expiry timestamps stay plaintext for cheap expiry and purge decisions.
- Session cookies must be `HttpOnly`, `Secure`, and `SameSite=Lax`.
- The cookie `Max-Age` must not exceed the server-side absolute session TTL.
- Session ids are rotated on successful login.
- The encrypted token blob format must carry a key version so encryption-key rotation is possible without ambiguous decrypt behavior.
- `id` is an internal surrogate used for row lifecycle and logging; it must not be exposed as a bearer credential.
- `session_token_hash` is unique so one raw session token resolves to at most one server-side session.
- `github_user_id` is the authorization subject for dashboard authentication only; repository access still requires fresh Repository Visibility Cache evidence.
- `github_user_access_token_expires_at` is nullable because GitHub App user tokens may not always include an expiry in the same way across flows; when present, it caps the effective session expiry.
- `last_seen_at` supports operational visibility and optional idle-extension decisions, but idle authorization is controlled by `idle_expires_at`.
- Trade-off: storing encrypted GitHub User Access Token material in D1 centralizes dashboard state and enables cross-installation reads, but it raises key-management risk. The guardrail is separate encryption secret, versioned blob format, plaintext expiry only, and immediate deletion on auth failure.

### Dashboard Session lifecycle

V1 behavior:

- Dashboard Sessions use a `2 hour` idle TTL and an `8 hour` absolute TTL.
- The effective session expiry is the earliest of `idle_expires_at`, `absolute_expires_at`, and `github_user_access_token_expires_at` when GitHub returns an access-token expiry.
- GitHub user refresh tokens are not persisted or used in v1.
- If a Dashboard Session expires, the GitHub User Access Token expires, or GitHub returns an authentication failure for a dashboard visibility request, Cyspbot deletes the Dashboard Session and redirects the Dashboard User to `/login/github`.
- Logout deletes the Dashboard Session row and clears the browser cookie.
- A successful login always creates a new Dashboard Session id and session token.
- There is no background refresh of Dashboard User token material in v1.

Future refresh-token path:

- A later implementation may store GitHub user refresh token material in `encrypted_github_user_token_blob`.
- Refresh must run only on demand during an authenticated dashboard request, not from a background job.
- A successful refresh must rotate the Dashboard Session id, rotate the raw session token, replace the encrypted token blob, and update plaintext expiry fields in one transaction.
- A failed refresh must delete the Dashboard Session and redirect the Dashboard User to `/login/github`.

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

Notes:

- `installation_id` is the immutable GitHub App Installation key and the aggregate key for Installation Reconciliation.
- `github_account_id`, `github_account_login_display`, and `github_account_type` describe the account that owns the installation. They are projection metadata, not dashboard-user authorization facts.
- `repository_selection` records GitHub's installation selection mode, but it must not be used to infer repository membership; membership comes from explicit repository edges.
- `suspended_at` and `deleted_at` are soft-state markers from GitHub. Reads must treat either marker as making the installation inactive unless a route documents a historical view.
- Trade-off: the projection keeps installation account metadata even though token issuance remains live against GitHub. This supports dashboard context and reconciliation operations without making projection authoritative for token issuance.

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
- `github_owner_id` is retained as GitHub-issued owner identity evidence; it is not enough to authorize dashboard access.
- `repository_visibility` is current projection metadata for display and filtering, not the Token Policy's live visibility check.
- `archived_at` and `deleted_at` are separate because archived repositories can still have useful audit history, while deleted repositories should disappear from normal navigation after retention.
- Trade-off: current-name uniqueness intentionally rejects alias-history routing in v1. That makes route resolution simple and prevents old names from becoming accidental authorization keys.

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
- The composite primary key prevents duplicate membership evidence for the same installation and repository.
- `created_at` and `updated_at` are edge-lifecycle metadata only; they must not be interpreted as first-installed or last-authorized timestamps without checking GitHub's contract.
- Trade-off: hard-deleting removed edges keeps current-state reads simple, but loses membership history. Historical token issuance remains available through Audit Log rows, which intentionally do not depend on this edge table.

### Repository Visibility Cache

```sql
CREATE TABLE repository_visibility_cache_entries (
  github_user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
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
- Repository Visibility Cache rows store repository presence only. GitHub repository permissions from the user-to-server installation repository response are not stored in v1 and are not used for dashboard authorization.
- A fresh row for `github_user_id + installation_id + repository_id` is the only Repository Visibility Cache authorization fact for repository detail access.
- Visibility Refresh may upsert the `github_app_installations`, `github_repositories`, and `github_app_installation_repositories` rows needed for the GitHub-returned positive visibility rows before replacing the cache slice.
- Those upserts are bootstrapping writes from GitHub's user-to-server installation repository API response; they must not delete repositories, delete installation membership edges, mark repositories or installations as deleted, or infer visibility for repositories GitHub did not return for the user.
- Installation Reconciliation remains the only writer that performs full installation-slice replacement, deletion, suspension, or removal decisions.
- Cache refresh replaces the full `user + installation` slice atomically.
- Visibility Refresh must fetch the complete paginated GitHub repository list for the `user + installation` slice before writing D1 changes.
- If any GitHub page fails, is incomplete, or cannot be validated, Visibility Refresh must leave existing projection and Repository Visibility Cache rows unchanged.
- After a complete GitHub fetch, Visibility Refresh commits one D1 transaction that:
  - upserts only the positive `github_app_installations`, `github_repositories`, and `github_app_installation_repositories` bootstrap rows returned by GitHub
  - deletes the previous `repository_visibility_cache_entries` rows for that `github_user_id + installation_id`
  - inserts the new `repository_visibility_cache_entries` rows for that same `github_user_id + installation_id`
- Dashboard authorization may use the refreshed Repository Visibility Cache rows only after that transaction commits.
- `github_user_id`, `installation_id`, and `repository_id` are all part of the primary key because GitHub reports visibility through a user-to-installation slice, and the same repository may appear under different installations over time.
- `checked_at` records when GitHub last confirmed the positive visibility row; `expires_at` is the only field that decides freshness.
- Trade-off: v1 stores positive presence only, not permissions or negative results. That avoids freezing mutable GitHub entitlements locally, but requires live refresh on misses and expiry.

### Audit Log

```sql
CREATE TABLE installation_token_issuance_audit_entries (
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

CREATE INDEX installation_token_issuance_audit_entries_by_caller_repository_requested_at
  ON installation_token_issuance_audit_entries(caller_repository_id, requested_at DESC, id DESC);

CREATE INDEX installation_token_issuance_audit_entries_by_installation_requested_at
  ON installation_token_issuance_audit_entries(installation_id, requested_at DESC, id DESC);

CREATE INDEX installation_token_issuance_audit_entries_by_requested_at
  ON installation_token_issuance_audit_entries(requested_at);
```

Notes:

- This is the required durable Audit Log record for Installation Token Issuance.
- `caller_repository_id`, `caller_repository_full_name_normalized`, `caller_repository_owner_id`, and `caller_repository_visibility` are the normalized GitHub-issued OIDC Caller context, captured before live GitHub lookup.
- `caller_repository_full_name_display` is the original GitHub repository claim spelling captured for audit display only. It must not be used for lookup, joins, authorization, or uniqueness.
- OIDC claim-derived columns are prefixed with `oidc_`, GitHub Actions claim-derived columns are prefixed with `github_` or `git_`, and Cyspbot outcome columns are unprefixed.
- `installation_id` is nullable because GitHub App Installation lookup can fail after Caller authentication but before the installation is known.
- A durable `pending` audit-intent row is written after OIDC authentication produces normalized Caller context and before any GitHub App Installation or repository lookup.
- The row is finalized to the terminal outcome in a second write after live GitHub lookup, policy evaluation, and, when applicable, after GitHub responds to the GitHub access-token request.
- Live GitHub lookup failures after caller authentication are finalized as `upstream_error` or `denied`, with reason rows that identify the failed stage.
- Terminal audit finalization and child-row writes must be one D1 transaction where D1 supports the required statement set.
- Installation Token Issuance must fail closed if the finalization write cannot be persisted.
- If GitHub issued a token but terminal finalization fails, Cyspbot still returns a server error.
- A durable `finalization_failed` row is only guaranteed when Cyspbot can persist the failure marker after a partial terminal-write failure.
- If D1 is unavailable and the failure marker cannot be persisted, the original `pending` intent row is the durable gap record and the runtime must emit an operational error suitable for alerting.
- Pre-authentication failures that never produce normalized Caller context stay in operational logs, not this table.
- Audit Log rows intentionally do not foreign-key to current projection tables because audit durability must not depend on Installation Reconciliation timing or projection retention.
- `audit_state` separates write lifecycle from the domain `outcome`. A row can be `pending` before GitHub lookup or token creation has produced a terminal outcome.
- `requested_at` is the stable event time for retention and ordering; `finalized_at` is the terminal write time and may lag.
- `installation_id` is nullable to preserve authenticated attempts that fail before GitHub returns an installation.
- Caller repository columns duplicate OIDC-derived identity rather than referencing projection so the evidence survives renames, transfers, and projection cleanup.
- `oidc_resolved_key_id` is nullable because not every verification failure has a resolved key; when present it supports key-rotation forensics without storing raw JWTs.
- `outcome` is nullable while `audit_state = 'pending'`; finalized rows must set it to exactly one terminal domain outcome.
- Trade-off: the table is intentionally wide for first-order audit facts. This avoids fragile JSON parsing in dashboard and export paths while keeping repeated reason and permission data in child tables.

### Audit outcome reasons

```sql
CREATE TABLE installation_token_issuance_audit_outcome_reasons (
  audit_log_entry_id INTEGER NOT NULL,
  outcome_reason TEXT NOT NULL,
  PRIMARY KEY (audit_log_entry_id, outcome_reason),
  FOREIGN KEY (audit_log_entry_id) REFERENCES installation_token_issuance_audit_entries(id) ON DELETE CASCADE
);
```

Notes:

- Populated for `outcome = 'denied'`, and for `upstream_error` or `internal_error` when a stable reason code is available.
- Policy denials use the same table as lookup and finalization-stage failures so audit consumers do not need a second reason model.
- Implementations may write only the canonical outcome reason codes documented below unless this design is updated.
- The primary key makes reason writes idempotent for a given audit entry and prevents noisy duplicate reasons.
- Reason codes are stable machine strings, not display messages. UI copy should map from the code so wording can change without rewriting audit history.
- Trade-off: reason codes lose arbitrary upstream detail by design. Rich error detail belongs in redacted operational logs, not durable audit rows that are shown to dashboard users.

Canonical outcome reason codes:

Policy denials:

- `policy_event_denied`
- `policy_ref_denied`
- `policy_ref_type_denied`
- `policy_repository_id_mismatch`
- `policy_repository_name_mismatch`
- `policy_repository_owner_id_mismatch`
- `policy_repository_visibility_mismatch`
- `policy_subject_mismatch`

GitHub lookup and upstream failures:

- `github_installation_not_found`
- `github_repository_not_found`
- `github_installation_suspended`
- `github_upstream_unavailable`
- `github_upstream_rate_limited`
- `github_upstream_unexpected_response`

Audit persistence and internal failures:

- `audit_intent_write_failed`
- `audit_finalization_write_failed`
- `audit_child_write_failed`
- `internal_configuration_error`
- `internal_unexpected_error`

### Issued token facts

```sql
CREATE TABLE issued_installation_tokens (
  audit_log_entry_id INTEGER PRIMARY KEY,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (audit_log_entry_id) REFERENCES installation_token_issuance_audit_entries(id) ON DELETE CASCADE
);

CREATE INDEX issued_installation_tokens_by_expires_at ON issued_installation_tokens(expires_at);
```

Notes:

- `issued_installation_tokens` is a strict 0-or-1 child of `installation_token_issuance_audit_entries`.
- Request-level audit facts are enough; no extra issued Installation Token fingerprint is stored in the first cut.
- `audit_log_entry_id` as the primary key enforces that at most one GitHub token issuance fact is attached to a request attempt.
- `expires_at` stores GitHub's returned token expiry for dashboard display and cleanup correlation; it must not imply Cyspbot can revoke or reuse the token.
- Trade-off: no token hash or fingerprint is stored. That reduces secret-derived persistence and avoids implying a revocation capability Cyspbot does not have.

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
- The composite primary key makes the returned permission map queryable without storing the whole map as JSON.
- Do not normalize permission names into a Cyspbot enum in v1; GitHub owns the permission vocabulary.
- Trade-off: exact GitHub strings are less type-safe than a local enum, but they avoid schema churn when GitHub adds permissions.

### Installation Reconciliation Runs

```sql
CREATE TABLE installation_reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  run_token TEXT NOT NULL UNIQUE,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('webhook', 'manual', 'retry')),
  run_status TEXT NOT NULL CHECK (run_status IN ('running', 'succeeded', 'failed', 'lost')),
  requested_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id) ON DELETE CASCADE
);

CREATE INDEX installation_reconciliation_runs_by_installation_started_at
  ON installation_reconciliation_runs(installation_id, started_at DESC);

CREATE INDEX installation_reconciliation_runs_by_status_lease
  ON installation_reconciliation_runs(run_status, lease_expires_at);
```

Notes:

- This table is the durable run history for Installation Reconciliation attempts.
- `run_token` is a random lease-owner token generated for one run.
- Running updates, heartbeat renewal, and terminal completion must match `run_token`.
- `lease_expires_at` is initially `5 minutes` after `started_at`.
- A running reconciliation renews its lease every `2 minutes` by updating `lease_expires_at` and `last_heartbeat_at`.
- If a scheduled retry finds `run_status = 'running'` with an expired `lease_expires_at`, it marks that run `lost`, records an `installation_reconciliation_lease_recovered` operational security event, and schedules a retry.
- `run_token` is a lease-owner token, not an authentication token. It prevents a stale executor from heartbeating or completing a newer run.
- `trigger_source` records how work entered the reconciliation loop; it must not change retry behavior except where explicitly documented.
- `error_code` is the durable stable failure classifier; `error_message` is operator-facing context and must be redacted.
- Trade-off: keeping run history in D1 instead of only Worker logs gives retry and support flows durable evidence, but retention is short and raw GitHub payloads stay out of the table.

### Installation Reconciliation State

```sql
CREATE TABLE installation_reconciliation_states (
  installation_id INTEGER PRIMARY KEY,
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('idle', 'pending', 'running', 'backoff')),
  reconciliation_requested INTEGER NOT NULL CHECK (reconciliation_requested IN (0, 1)),
  last_requested_at TEXT,
  current_run_id INTEGER,
  last_successful_run_id INTEGER,
  last_failed_run_id INTEGER,
  consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (current_run_id) REFERENCES installation_reconciliation_runs(id),
  FOREIGN KEY (last_successful_run_id) REFERENCES installation_reconciliation_runs(id),
  FOREIGN KEY (last_failed_run_id) REFERENCES installation_reconciliation_runs(id)
);

CREATE INDEX installation_reconciliation_states_by_state_next_retry
  ON installation_reconciliation_states(reconciliation_state, next_retry_at);
```

Notes:

- This table is a compact scheduler and signal-coalescing index, not a history stream.
- `current_run_id` points at the active row in `installation_reconciliation_runs` when a run is in progress.
- `last_successful_run_id` and `last_failed_run_id` point at terminal run-history rows for cheap operational summaries.
- `consecutive_failure_count` drives retry backoff. Total attempts are counted from `installation_reconciliation_runs`.
- `reconciliation_requested` is separate from `reconciliation_state` so a signal arriving during a run can request exactly one follow-up pass.
- `current_run_id` is nullable outside `running` and must be cleared on terminal completion or lost-run recovery.
- `next_retry_at` is meaningful only in `backoff`; retry scans must include the state check, not just the timestamp.
- Trade-off: this compact state row is easier to reason about than deriving scheduler state from run history, but it must be updated transactionally with run-row transitions to avoid stuck installations.

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
- `delivery_id` is GitHub's idempotency key for a delivery; retries with the same delivery id must not create multiple durable delivery rows.
- `installation_id` is nullable because malformed, unsupported, or non-installation deliveries can still be useful operational evidence.
- `delivery_accepted` records whether the delivery was accepted for downstream reconciliation, while `response_status_code` records the public HTTP response.
- `webhook_signature_valid` is stored so rejected signed-envelope failures are distinguishable from accepted deliveries without retaining the raw body or signature.
- `delivery_metadata_json` may include redacted envelope fields only; it must not include raw payload bodies, secrets, signatures, or OAuth material.
- Trade-off: metadata-only logging makes replay from Cyspbot impossible, but GitHub remains the webhook delivery source and this avoids creating a long-lived payload archive.

## Durable Object storage shapes

### `GitHubInstallationObject`

This Durable Object remains in the system, but only as the installation-scoped Installation Coordinator.

It persists only minimal reconstructable coordination state in Durable Object key-value storage.

Suggested local state shape:

```ts
interface InstallationReconcileState {
  reconcileRequested: boolean;
  reconcileRunning: boolean;
  currentRunId?: number;
  currentRunToken?: string;
  lastSignalAt?: string;
}
```

Semantics:

- exactly one logical local state object
- `reconcileRequested = true` means at least one reconcile signal has been latched
- `reconcileRunning = true` means a pass is currently executing
- `currentRunId` and `currentRunToken` mirror the D1 run row for the currently running pass when present
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
- joined to current Audit Log summary derived from `installation_token_issuance_audit_entries`

Rules:

- show all currently visible repositories, even if they have zero Audit Log history
- active repositories first
- archived repositories in a separate section at the bottom
- within each section:
  - repositories with history sort by `last_installation_token_issuance_at DESC`
  - repositories without history sort by `full_name_display ASC`
- use current projection `full_name_display` for display

Suggested summary projection strategy:

- either compute on read from `installation_token_issuance_audit_entries`
- or maintain a cheap SQL-side summary column/materialized projection later

The first cut does not require a separate summary table.

### Dashboard details

Route:

- `/dashboard/repositories/:owner/:name`

Route semantics:

- The repository detail route uses the current normalized `owner/name` as a user-facing locator only.
- If a repository has been renamed or transferred, old `owner/name` URLs return `404` in the first cut.
- `/dashboard` is the canonical entrypoint and must generate links from current projection rows.
- Do not add alias-history routing in the first cut; historical names remain audit display evidence only.

Resolution:

1. resolve current repository projection by current `owner/name`
2. if none exists, return `404`
3. check the fresh Repository Visibility Cache by `github_user_id + repository_id`
4. on missing or expired cache, refresh the relevant installation slice once
5. if the refresh fails, return `503`
6. if still unauthorized, return `404`
7. query last 5 `installation_token_issuance_audit_entries` rows by `caller_repository_id`
8. left join optional `issued_installation_tokens` and `issued_installation_token_permissions`

UI behavior:

- header shows current repository name from projection
- rows show request-level facts first
- `issued` rows inline `expires_at` and compact permissions summary
- if historical `caller_repository_full_name_display` differs from current `full_name_display`, show a small “recorded as …” note on that row
- `installation_id` is secondary row metadata only

## Client-side UI implementation design

The dashboard is an operational audit surface, not a workflow control plane.

Decision:
Use progressively enhanced server-rendered HTML for the first cut. Client-side JavaScript may improve filtering, sorting, disclosure, and refresh ergonomics, but it must not become the authorization boundary or a second data model.

Why:

- The dashboard has two stable read surfaces and a small amount of state.
- Server-rendered pages keep repository visibility checks and audit queries on the trusted side of the Worker boundary.
- A full client-side application would add routing, hydration, API, and cache-invalidation surface before there is enough interaction complexity to justify it.

Rejected for the first cut:

- A single-page application with client-side route authorization.
- Browser-side calls that fetch raw Audit Log rows independently of the server-rendered page authorization path.
- Client-side Repository Visibility Cache state beyond what is rendered for the current response.
- Real-time updates or WebSocket-style subscription to reconciliation/audit events.

Allowed client-side behavior:

- local filtering of the already-rendered repository list
- local sorting among already-rendered rows when all sorted fields are present in the HTML
- expanding and collapsing per-row details that were already authorized and rendered
- copying non-secret values such as repository names, reason codes, run ids, refs, and timestamps
- submitting normal navigation or refresh forms back to server routes

Not allowed client-side behavior:

- storing GitHub User Access Tokens, session tokens, encrypted token blobs, OAuth state, raw OIDC tokens, webhook payloads, or Installation Tokens
- embedding raw Audit Log JSON, raw webhook metadata JSON, or unredacted error detail in `<script>` tags
- deciding whether a Dashboard User may see a repository or audit row
- hiding unauthorized data with CSS or client-side filtering after sending it to the browser
- treating stale rendered repository names as enabled links when the server did not authorize fresh detail access

Client data contract:

- HTML is the durable browser contract for v1.
- If JavaScript needs structured data, embed only minimal redacted view models in inert JSON script tags with `type="application/json"`.
- Embedded view models must use display-ready strings and stable ids already authorized for the current page.
- Do not embed access tokens, session-token hashes, encrypted token blobs, raw GitHub API responses, raw audit payloads, or raw webhook payloads.
- The server must HTML-escape text content and JSON-escape any embedded structured data.

Dashboard list page:

- Primary content is a dense repository table or list generated from current projection rows joined to fresh Repository Visibility Cache rows.
- Show active repositories before archived repositories.
- Clearly separate archived repositories from active repositories.
- Show a visible degraded state when GitHub visibility refresh failed and stale repository names are rendered only as navigation context.
- In degraded state, do not render enabled detail links, audit summaries, or controls that imply fresh authorization.
- Empty state must distinguish "GitHub returned no visible repositories" from "visibility refresh failed".
- Client-side filtering may narrow the rendered list by owner/name, visibility, archived state, and recent issuance outcome if those fields are already present.

Repository detail page:

- The server must authorize by fresh Repository Visibility Cache before rendering any audit rows.
- Header uses current projection `full_name_display`.
- Route params are a locator only; after resolution, all audit queries and UI row identity use immutable `repository_id`.
- Show the last 5 Installation Token Issuance rows in reverse request time.
- Use outcome-specific visual treatment, but text labels must remain present without color dependence.
- Show policy or failure reason codes as stable machine-readable codes first; optional display copy may be added beside them.
- For issued rows, show token expiry and returned permissions, but never show token values, token hashes, or secret-derived fingerprints.
- If `caller_repository_full_name_display` differs from current projection display name, show "recorded as ..." on that audit row.
- If a row has `audit_state = 'pending'` or `finalization_failed`, show the audit state explicitly rather than inferring success or denial from missing child rows.

Navigation and routing:

- `/dashboard` is the canonical entrypoint and produces links using current projection `owner/name`.
- Detail links must use URL-encoded current display owner/name, not `repository_id`.
- Client-side routing must not be introduced in v1; browser navigation should make normal GET requests so authorization runs server-side for every page.
- Old repository names after rename or transfer return `404`; do not implement client-side alias redirects.

Refresh behavior:

- Automatic background refresh is not part of v1.
- A manual refresh control that performs Visibility Refresh must submit a non-GET request to a server route and redirect back after completion.
- Refresh controls must show whether the page is using fresh visibility, stale degraded context, or a failed refresh state.
- Do not poll GitHub or D1 from the browser.

Error and loading states:

- Missing or expired Dashboard Session redirects to `/login/github`.
- Repository not found or no longer visible returns `404`; the UI must not distinguish those cases for unauthorized users.
- GitHub visibility refresh failure on a repository detail request returns `503`.
- Dashboard list refresh failure may render degraded stale navigation context only under the stale visibility rules.
- Public UI errors stay minimal; operator detail belongs in structured Worker logs.

Security headers and browser controls:

- Dashboard HTML responses should set `Cache-Control: no-store`.
- Dashboard HTML responses should set a restrictive Content Security Policy. For the first cut, prefer no third-party scripts and no inline script; if inline CSS remains, allow it explicitly only for styles.
- Set `X-Frame-Options: DENY` or the CSP `frame-ancestors 'none'` equivalent.
- Avoid third-party fonts, analytics, images, or client SDKs in v1.
- Forms that mutate server-side session or refresh state must use non-GET methods, existing session authentication, and an explicit CSRF control.

Accessibility and usability guardrails:

- The dashboard is a work-focused operational surface. Prioritize scannable tables, clear status labels, predictable navigation, and compact controls over marketing-style layout.
- Every status conveyed by color must also have text.
- Tables must remain readable on narrow screens without losing column labels.
- Times should render as UTC by default, with client-local formatting only as progressive enhancement and never as the only displayed value.
- Long refs, workflow refs, repository names, and reason codes must wrap or truncate without overlapping adjacent content.
- Controls must be usable by keyboard and have visible focus states.

Implementation guardrails:

- Keep rendering functions pure: input view model to escaped HTML string.
- Keep authorization, visibility refresh, and audit queries outside rendering functions.
- Prefer route-specific view models over passing database rows directly into HTML rendering.
- Add tests for escaping, route-link encoding, stale/degraded list rendering, hidden unauthorized detail links, pending/finalization-failed audit rows, and long text wrapping classes.
- Do not add a frontend framework until there is a concrete interaction that server-rendered HTML plus small progressive enhancement cannot handle.

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

## Installation Token Issuance

Installation Token Issuance remains live against GitHub:

- write a durable Audit Log intent row to D1 after OIDC authentication and caller-context normalization
- if D1 is unavailable before the audit intent row is written, fail before any live GitHub App Installation lookup or GitHub access-token request
- resolve installation live from GitHub
- resolve repository metadata live from GitHub
- evaluate token policy against live metadata
- request a fresh GitHub App installation access token from GitHub
- finalize `installation_token_issuance_audit_entries` and any child rows in D1
- if the finalization write fails, return a server error even if GitHub already issued the token

Installation Token Issuance does not update installation or repository projection opportunistically.

## Operational security events

V1 records operational security events as structured Worker logs only. These events are not stored in D1 in the first cut.

Required fields:

- `event_name`
- `occurred_at`
- `request_id` when available
- `github_user_id` when the event is associated with a Dashboard User
- `installation_id` when known
- `repository_id` when relevant
- `error_class`
- `degraded_output_rendered` for dashboard visibility failures

Required event names:

- `dashboard_visibility_refresh_failed`
- `dashboard_session_auth_failed`
- `installation_token_issuance_audit_intent_failed`
- `installation_token_issuance_audit_finalization_failed`
- `webhook_delivery_validation_failed`
- `webhook_receiver_not_configured`
- `installation_reconciliation_lease_recovered`

Rules:

- Structured operational security logs must not include raw tokens, encrypted token blobs, webhook payload bodies, OAuth codes, OAuth state values, session tokens, session-token hashes, or raw OIDC tokens.
- Public responses remain minimal even when operational security logs carry richer diagnostic context.
- A future D1 `operational_security_events` table may be added if dashboard-visible operator diagnostics become a product requirement.

Auth and redirect controls:

- `/login/github` creates an OAuth `state` value and stores it in a signed short-lived cookie named `__Host-cyspbot_oauth_state` before redirecting to GitHub.
- The OAuth state cookie uses `Path=/`, does not set a `Domain` attribute, and is `HttpOnly`, `Secure`, and `SameSite=Lax`.
- `/auth/github/callback` must validate the returned `state` before exchanging the code.
- Return targets are validated against an explicit allowlist of dashboard route shapes:
  - `/dashboard`
  - `/dashboard/repositories/:owner/:name`
- Any invalid or unrecognized return target is normalized to `/dashboard`.

## Operational design checks

These checks are ordered by request flow and should be used during implementation review.

1. Dashboard login creates a Dashboard User and Dashboard Session only after GitHub App user authorization succeeds. The failure case being guarded is a local session for a user whose GitHub authorization did not complete.
2. Dashboard session lookup authorizes only the web session. It must not imply repository access, org access, or GitHub App Installation membership.
3. Dashboard visibility refresh fetches every GitHub page for one `github_user_id + installation_id` slice before touching D1. The failure case being guarded is a partial page fetch deleting or narrowing valid visibility rows.
4. Repository detail access resolves the current repository projection first, refreshes stale or missing user visibility once, and shows audit data only after a fresh positive cache row exists. The failure case being guarded is historical audit evidence leaking to a user who no longer has GitHub visibility.
5. Installation Token Issuance writes the audit intent before live GitHub lookup or token creation. The failure case being guarded is an issued token with no durable authenticated request record.
6. Installation Token Issuance finalizes the audit row and child rows after GitHub response. The failure case being guarded is a dashboard-visible success without the returned expiry and permissions GitHub actually issued.
7. Webhook receipt validates signature and envelope before signaling reconciliation, then records delivery metadata without storing the raw body. The failure case being guarded is unsigned input mutating projection state or creating a long-lived webhook payload archive.
8. Installation Reconciliation is serialized by `GitHubInstallationObject` and committed atomically per installation slice. The failure case being guarded is concurrent or partial projection replacement that mixes old and new GitHub state.
9. Retry recovery treats expired reconciliation leases as lost work and schedules another pass. The failure case being guarded is a permanently stuck installation after Worker termination.
10. Cleanup runs from a scheduled Worker and respects retention indexes and state references. The failure case being guarded is relying on read traffic for retention or deleting run rows still referenced by scheduler state.

## Reconciliation flow

### Writer ownership

- Installation Token Issuance writes only Audit Log tables
- Dashboard authentication and Visibility Refresh write:
  - `dashboard_users`
  - `dashboard_sessions`
  - positive projection bootstrap rows for GitHub-returned visible repositories only
  - `repository_visibility_cache_entries`
- Installation Reconciliation writes:
  - `github_app_installations`
  - `github_repositories`
  - `github_app_installation_repositories`
  - `installation_reconciliation_states`
  - `installation_reconciliation_runs`
  - `webhook_delivery_log_entries`

### Execution model

1. webhook or manual request signals Installation Reconciliation for one GitHub App Installation
2. signal goes through `GitHubInstallationObject`
3. DO latches `reconciliation_requested = 1` in `installation_reconciliation_states`
4. DO executes one Installation Reconciliation pass if not already running
5. DO creates an `installation_reconciliation_runs` row with `run_status = 'running'`, a random `run_token`, and a `5 minute` lease
6. DO updates `installation_reconciliation_states` with `reconciliation_state = 'running'`, `current_run_id`, and clears `reconciliation_requested`
7. the running pass renews the run lease every `2 minutes` by updating the run row with a matching `run_token`
8. Installation Reconciliation fetches the authoritative installation snapshot from GitHub
9. if the snapshot is complete, replace/update installation projection atomically in D1
10. on success, mark the run `succeeded`, set `last_successful_run_id`, reset `consecutive_failure_count` to `0`, set `reconciliation_state = 'idle'` if no signal arrived while running or `pending` if one did, and clear `current_run_id`
11. on failure, mark the run `failed`, set `last_failed_run_id`, increment `consecutive_failure_count`, set `reconciliation_state = 'backoff'`, set `next_retry_at`, clear `current_run_id`, and leave `reconciliation_requested = 1`

Crash recovery rule:

- if the scheduler finds a state row with `reconciliation_state = 'running'` whose current run has expired `lease_expires_at`, it marks the run `lost`, marks the installation back to `pending`, preserves `reconciliation_requested = 1`, records a timeout-style failure code, emits `installation_reconciliation_lease_recovered`, and re-pokes the installation DO

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

- `installation_token_issuance_audit_entries` and all child rows: `180 days`
- soft-deleted `github_repositories`: `180 days`
- soft-deleted `github_app_installations`: `180 days`
- `dashboard_sessions`:
  - invalidated sessions: delete immediately
  - expired sessions: purge within `24 hours`
- `repository_visibility_cache_entries`: purge expired Repository Visibility Cache rows within `24 hours`
- `installation_reconciliation_states`: keep one row per non-deleted GitHub App Installation
- `installation_reconciliation_runs`: keep terminal run rows for `30 days`; do not purge a row referenced by `installation_reconciliation_states.current_run_id`, `last_successful_run_id`, or `last_failed_run_id`
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
  - `installation_token_issuance_audit_entries`
  - `issued_installation_tokens`
  - `issued_installation_token_permissions`
  - `installation_token_issuance_audit_outcome_reasons`

This phase makes the central Audit Log and SQL-backed Dashboard Sessions possible before the dashboard rewrite.

### Phase 2: Installation Token Issuance audit cutover

- write Audit Log records to D1
- make audit persistence mandatory for issuance success
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

### Phase 4: projection and visibility schema

- add:
  - `github_app_installations`
  - `github_repositories`
  - `github_app_installation_repositories`
  - `repository_visibility_cache_entries`
  - `installation_reconciliation_states`
  - `installation_reconciliation_runs`
  - `webhook_delivery_log_entries`
- do not route dashboard authorization through these tables yet
- keep Installation Token Issuance live against GitHub

### Phase 5: Visibility Refresh implementation

- implement login-driven and on-demand Visibility Refresh
- replace only the `user + installation` Repository Visibility Cache slice returned by GitHub
- allow positive projection bootstrap upserts from Visibility Refresh only for repositories GitHub returned
- do not delete projection rows, mark repositories deleted, or infer absence from Visibility Refresh
- keep Installation Token Issuance live against GitHub

### Phase 6: Installation Reconciliation writer

- narrow `GitHubInstallationObject` to Installation Reconciliation coalescing and serialized execution only
- route manual Installation Reconciliation signals through the DO
- write Installation Reconciliation outcomes to D1
- add scheduled retry dispatcher
- make Installation Reconciliation the only writer for full installation-slice replacement, deletion, suspension, or removal decisions
- keep Installation Token Issuance live against GitHub

### Phase 7: webhook delivery metadata

- route webhook Installation Reconciliation signals through the DO
- write webhook delivery metadata to D1
- keep Installation Token Issuance live against GitHub

### Phase 8: dashboard rewrite

- rebuild `/dashboard`
- rebuild `/dashboard/repositories/:owner/:name`
- authorize by projection + fresh Repository Visibility Cache
- add fail-closed repository detail authorization and degraded stale list context for GitHub-unavailable cases
- remove any repository-id route shape from the prototype

### Phase 9: cleanup and deletion of obsolete prototype paths

- remove installation-local Audit Log persistence
- remove prototype dashboard and Dashboard Session code paths
- add cleanup jobs for Dashboard Sessions, Repository Visibility Cache, Audit Log retention, Installation Reconciliation state, and Webhook Delivery Log rows

### Phase 10: optional follow-ups

- add repository list summary projection if query cost requires it
- add operator diagnostics UI or reports for Installation Reconciliation failures
- add future permission-intersection Audit Log fields only when that feature actually exists

Each phase must leave exactly one authoritative read path for any given concern. Compatibility scaffolding may exist temporarily, but it must not create competing durable sources of truth.

## Resolved design checks

### D1 table scope

Decision:
D1 table scope is split between durable facts, current GitHub-derived projection, derived expiring cache state, and operational metadata.

Guardrails:

- Audit Log rows and issued Installation Token child rows are durable facts and must not authorize dashboard repository detail access.
- Repository projection rows are current-state GitHub-derived data and must not authorize dashboard repository detail access without a fresh Repository Visibility Cache row.
- Repository Visibility Cache rows are the only D1 rows that may authorize dashboard repository detail access, and only while fresh.
- Audit Log rows intentionally do not foreign-key to projection rows.

### Installation Coordinator scope

Decision:
`GitHubInstallationObject` remains only as the per-installation Installation Coordinator.

Guardrails:

- It coalesces signals and serializes Installation Reconciliation execution.
- Its local state must be reconstructable from D1 plus a new signal.
- It must not become the durable owner of audit records, projection rows, visibility rows, sessions, retry counters, or failure history.

### Repository route semantics

Decision:
Current-name-only dashboard repository URLs are acceptable for the first cut.

Guardrails:

- Resolve detail routes by current normalized `owner/name`, then use immutable `repository_id` internally.
- Return `404` for old names after rename or transfer.
- Generate canonical detail links from `/dashboard` using current projection display names.
- Keep historical names as audit-row display evidence only; do not add alias-history routing until there is a concrete product need.

### Installation Token Issuance strictness

Decision:
Installation Token Issuance remains live-authoritative against GitHub and fail-closed on mandatory audit durability.

Guardrails:

- No GitHub App Installation lookup or GitHub access-token request happens unless the post-OIDC audit intent row has been written.
- Installation and repository metadata used for Token Policy evaluation come from live GitHub reads.
- The final audit write and issued Installation Token child rows are mandatory for success.
- If GitHub issued a token but finalization fails, Cyspbot returns a server error and emits an operational alert tied to the pending audit row when possible.

### Rollout size

Decision:
The rollout is split so each phase introduces only one durable authority or read-path transition.

Guardrails:

- Schema bootstrap does not change dashboard authorization.
- Visibility Refresh implementation lands before dashboard detail pages consume it.
- Installation Reconciliation owns full projection replacement before webhook delivery metadata is used for operations.
- Cleanup does not start until the D1-backed path is the only authoritative path for the relevant concern.
