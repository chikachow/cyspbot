PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pull_request_haiku_repository_opt_ins (
  repository_id INTEGER PRIMARY KEY,
  repository_full_name_display TEXT NOT NULL,
  enabled_at TEXT NOT NULL,
  enabled_by TEXT
);

CREATE TABLE IF NOT EXISTS pull_request_haiku_comments (
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  repository_full_name_display TEXT NOT NULL,
  comment_id INTEGER,
  current_head_sha TEXT,
  last_rendered_head_sha TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pull_request_number)
);

CREATE TABLE IF NOT EXISTS pull_request_haiku_runs (
  delivery_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  repository_full_name_display TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  run_status TEXT NOT NULL CHECK (run_status IN ('queued', 'running', 'succeeded', 'skipped', 'failed')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  comment_id INTEGER,
  ai_model TEXT,
  output_kind TEXT CHECK (output_kind IN ('markdown')),
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pull_request_haiku_runs_by_repository_pr_queued_at
  ON pull_request_haiku_runs(repository_id, pull_request_number, queued_at DESC);

