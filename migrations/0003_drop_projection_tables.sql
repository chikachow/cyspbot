PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS installation_reconciliation_runs_new (
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

INSERT INTO installation_reconciliation_runs_new (
  id,
  installation_id,
  run_token,
  trigger_source,
  run_status,
  requested_at,
  started_at,
  lease_expires_at,
  last_heartbeat_at,
  completed_at,
  error_code,
  error_message,
  created_at,
  updated_at
)
SELECT
  id,
  installation_id,
  run_token,
  trigger_source,
  run_status,
  requested_at,
  started_at,
  lease_expires_at,
  last_heartbeat_at,
  completed_at,
  error_code,
  error_message,
  created_at,
  updated_at
FROM installation_reconciliation_runs;

DROP TABLE installation_reconciliation_runs;
ALTER TABLE installation_reconciliation_runs_new RENAME TO installation_reconciliation_runs;

CREATE INDEX IF NOT EXISTS installation_reconciliation_runs_by_installation_started_at
  ON installation_reconciliation_runs(installation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS installation_reconciliation_runs_by_status_lease
  ON installation_reconciliation_runs(run_status, lease_expires_at);

CREATE TABLE IF NOT EXISTS installation_reconciliation_states_new (
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

INSERT INTO installation_reconciliation_states_new (
  installation_id,
  reconciliation_state,
  reconciliation_requested,
  last_requested_at,
  current_run_id,
  last_successful_run_id,
  last_failed_run_id,
  consecutive_failure_count,
  next_retry_at,
  updated_at
)
SELECT
  installation_id,
  reconciliation_state,
  reconciliation_requested,
  last_requested_at,
  current_run_id,
  last_successful_run_id,
  last_failed_run_id,
  consecutive_failure_count,
  next_retry_at,
  updated_at
FROM installation_reconciliation_states;

DROP TABLE installation_reconciliation_states;
ALTER TABLE installation_reconciliation_states_new RENAME TO installation_reconciliation_states;

CREATE INDEX IF NOT EXISTS installation_reconciliation_states_by_state_next_retry
  ON installation_reconciliation_states(reconciliation_state, next_retry_at);

CREATE TABLE IF NOT EXISTS webhook_delivery_log_entries_new (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  github_event TEXT NOT NULL,
  installation_id INTEGER,
  delivery_accepted INTEGER NOT NULL CHECK (delivery_accepted IN (0, 1)),
  webhook_signature_valid INTEGER NOT NULL CHECK (webhook_signature_valid IN (0, 1)),
  response_status_code INTEGER NOT NULL,
  delivery_metadata_json TEXT
);

INSERT INTO webhook_delivery_log_entries_new (
  delivery_id,
  received_at,
  github_event,
  installation_id,
  delivery_accepted,
  webhook_signature_valid,
  response_status_code,
  delivery_metadata_json
)
SELECT
  delivery_id,
  received_at,
  github_event,
  installation_id,
  delivery_accepted,
  webhook_signature_valid,
  response_status_code,
  delivery_metadata_json
FROM webhook_delivery_log_entries;

DROP TABLE webhook_delivery_log_entries;
ALTER TABLE webhook_delivery_log_entries_new RENAME TO webhook_delivery_log_entries;

CREATE INDEX IF NOT EXISTS webhook_delivery_log_entries_by_received_at
  ON webhook_delivery_log_entries(received_at);
CREATE INDEX IF NOT EXISTS webhook_delivery_log_entries_by_installation_received_at
  ON webhook_delivery_log_entries(installation_id, received_at DESC);

DROP TABLE IF EXISTS github_app_installation_repositories;
DROP TABLE IF EXISTS github_repositories;
DROP TABLE IF EXISTS github_app_installations;

PRAGMA foreign_keys = ON;
