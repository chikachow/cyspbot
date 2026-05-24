PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dashboard_users (
  github_user_id TEXT PRIMARY KEY,
  github_login_display TEXT NOT NULL,
  last_github_auth_at TEXT NOT NULL,
  session_revoked_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
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

CREATE INDEX IF NOT EXISTS dashboard_sessions_by_user_id ON dashboard_sessions(github_user_id);
CREATE INDEX IF NOT EXISTS dashboard_sessions_by_idle_expires_at
  ON dashboard_sessions(idle_expires_at);
CREATE INDEX IF NOT EXISTS dashboard_sessions_by_absolute_expires_at
  ON dashboard_sessions(absolute_expires_at);

CREATE TABLE IF NOT EXISTS installation_token_issuance_audit_entries (
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

CREATE INDEX IF NOT EXISTS installation_token_issuance_audit_entries_by_caller_repository_requested_at
  ON installation_token_issuance_audit_entries(caller_repository_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS installation_token_issuance_audit_entries_by_installation_requested_at
  ON installation_token_issuance_audit_entries(installation_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS installation_token_issuance_audit_entries_by_requested_at
  ON installation_token_issuance_audit_entries(requested_at);

CREATE TABLE IF NOT EXISTS installation_token_issuance_audit_outcome_reasons (
  audit_log_entry_id INTEGER NOT NULL,
  outcome_reason TEXT NOT NULL,
  PRIMARY KEY (audit_log_entry_id, outcome_reason),
  FOREIGN KEY (audit_log_entry_id) REFERENCES installation_token_issuance_audit_entries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issued_installation_tokens (
  audit_log_entry_id INTEGER PRIMARY KEY,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (audit_log_entry_id) REFERENCES installation_token_issuance_audit_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS issued_installation_tokens_by_expires_at
  ON issued_installation_tokens(expires_at);

CREATE TABLE IF NOT EXISTS issued_installation_token_permissions (
  audit_log_entry_id INTEGER NOT NULL,
  permission_name TEXT NOT NULL,
  permission_access TEXT NOT NULL,
  PRIMARY KEY (audit_log_entry_id, permission_name),
  FOREIGN KEY (audit_log_entry_id) REFERENCES issued_installation_tokens(audit_log_entry_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS installation_reconciliation_runs (
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS installation_reconciliation_runs_by_installation_started_at
  ON installation_reconciliation_runs(installation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS installation_reconciliation_runs_by_status_lease
  ON installation_reconciliation_runs(run_status, lease_expires_at);

CREATE TABLE IF NOT EXISTS installation_reconciliation_states (
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
  FOREIGN KEY (current_run_id) REFERENCES installation_reconciliation_runs(id),
  FOREIGN KEY (last_successful_run_id) REFERENCES installation_reconciliation_runs(id),
  FOREIGN KEY (last_failed_run_id) REFERENCES installation_reconciliation_runs(id)
);

CREATE INDEX IF NOT EXISTS installation_reconciliation_states_by_state_next_retry
  ON installation_reconciliation_states(reconciliation_state, next_retry_at);

CREATE TABLE IF NOT EXISTS webhook_delivery_log_entries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  github_event TEXT NOT NULL,
  installation_id INTEGER,
  delivery_accepted INTEGER NOT NULL CHECK (delivery_accepted IN (0, 1)),
  webhook_signature_valid INTEGER NOT NULL CHECK (webhook_signature_valid IN (0, 1)),
  response_status_code INTEGER NOT NULL,
  delivery_metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS webhook_delivery_log_entries_by_received_at
  ON webhook_delivery_log_entries(received_at);
CREATE INDEX IF NOT EXISTS webhook_delivery_log_entries_by_installation_received_at
  ON webhook_delivery_log_entries(installation_id, received_at DESC);
