import type { Env } from "../env.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";

export interface AuditIntent {
  id: number;
  requestedAt: string;
}

export interface RepositoryAuditSummary {
  lastInstallationTokenIssuanceAt: string | null;
  lastOutcome: string | null;
}

export interface RepositoryAuditEntryRecord {
  actor: string | null;
  auditState: "finalization_failed" | "finalized" | "pending";
  eventName: string;
  expiresAt: string | null;
  fullNameDisplay: string;
  id: number;
  installationId: number | null;
  outcome: "denied" | "internal_error" | "issued" | "upstream_error" | null;
  permissions: Record<string, string>;
  reasons: string[];
  ref: string | null;
  requestedAt: string;
  workflowRef: string | null;
}

type AuditRow = Record<
  | "audit_state"
  | "caller_repository_full_name_display"
  | "github_actions_event_name"
  | "requested_at",
  string
> &
  Record<
    "expires_at" | "github_actor" | "github_ref" | "github_workflow_ref" | "outcome",
    string | null
  > &
  Record<"id", number> &
  Record<"installation_id", number | null>;

type RepositoryAuditSummaryRow = Record<
  "last_installation_token_issuance_at" | "last_outcome",
  string | null
> &
  Record<"repository_id", number>;

export async function createAuditIntent(
  env: Env,
  principal: GitHubActionsPrincipal,
  issuer: string,
  resolvedKeyId: string | null,
  requestedAt: string,
): Promise<AuditIntent> {
  const repositoryId = parseRepositoryId(principal.repositoryId);
  const result = await env.DB.prepare(
    `
      INSERT INTO installation_token_issuance_audit_entries (
        requested_at,
        audit_state,
        caller_repository_id,
        caller_repository_full_name_normalized,
        caller_repository_full_name_display,
        caller_repository_owner_id,
        caller_repository_visibility,
        oidc_subject,
        oidc_issuer,
        oidc_resolved_key_id,
        github_actions_event_name,
        github_ref,
        github_ref_type,
        github_workflow_ref,
        github_job_workflow_ref,
        github_run_id,
        github_run_attempt,
        git_sha,
        github_actor
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      requestedAt,
      repositoryId,
      normalizeRepositoryFullName(principal.repository),
      principal.repository,
      principal.repositoryOwnerId ?? "",
      principal.repositoryVisibility ?? "",
      principal.rawSubject,
      issuer,
      resolvedKeyId,
      principal.eventName,
      principal.ref,
      principal.refType,
      principal.workflowRef,
      principal.jobWorkflowRef,
      principal.runId,
      principal.runAttempt,
      principal.sha,
      principal.actor,
    )
    .run();

  return {
    id: result.meta.last_row_id,
    requestedAt,
  };
}

export async function finalizeAuditEntry(
  env: Env,
  input: {
    auditEntryId: number;
    expiresAt?: string;
    finalizedAt: string;
    installationId?: number;
    outcome: "denied" | "internal_error" | "issued" | "upstream_error";
    permissions?: Record<string, string>;
    reasons?: string[];
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
        UPDATE installation_token_issuance_audit_entries
        SET audit_state = 'finalized',
          finalized_at = ?,
          installation_id = ?,
          outcome = ?
        WHERE id = ?
      `,
    ).bind(input.finalizedAt, input.installationId ?? null, input.outcome, input.auditEntryId),
  ];

  if (input.expiresAt !== undefined) {
    statements.push(
      env.DB.prepare(
        `
          INSERT INTO issued_installation_tokens (audit_log_entry_id, expires_at)
          VALUES (?, ?)
        `,
      ).bind(input.auditEntryId, input.expiresAt),
    );
  }

  for (const reason of input.reasons ?? []) {
    statements.push(
      env.DB.prepare(
        `
          INSERT OR IGNORE INTO installation_token_issuance_audit_outcome_reasons (
            audit_log_entry_id,
            outcome_reason
          ) VALUES (?, ?)
        `,
      ).bind(input.auditEntryId, reason),
    );
  }

  for (const [permissionName, permissionAccess] of Object.entries(input.permissions ?? {})) {
    statements.push(
      env.DB.prepare(
        `
          INSERT OR REPLACE INTO issued_installation_token_permissions (
            audit_log_entry_id,
            permission_name,
            permission_access
          ) VALUES (?, ?, ?)
        `,
      ).bind(input.auditEntryId, permissionName, permissionAccess),
    );
  }

  await env.DB.batch(statements);
}

export async function markAuditFinalizationFailed(
  env: Env,
  auditEntryId: number,
  finalizedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE installation_token_issuance_audit_entries
      SET audit_state = 'finalization_failed',
        finalized_at = ?,
        outcome = 'internal_error'
      WHERE id = ?
    `,
  )
    .bind(finalizedAt, auditEntryId)
    .run();
}

export async function listRepositoryAuditEntries(
  env: Env,
  repositoryId: number,
  limit: number,
): Promise<RepositoryAuditEntryRecord[]> {
  const rows = await env.DB.prepare(
    `
      SELECT
        installation_token_issuance_audit_entries.id,
        installation_token_issuance_audit_entries.requested_at,
        installation_token_issuance_audit_entries.audit_state,
        installation_token_issuance_audit_entries.installation_id,
        installation_token_issuance_audit_entries.caller_repository_full_name_display,
        installation_token_issuance_audit_entries.github_actions_event_name,
        installation_token_issuance_audit_entries.github_ref,
        installation_token_issuance_audit_entries.github_workflow_ref,
        installation_token_issuance_audit_entries.github_actor,
        installation_token_issuance_audit_entries.outcome,
        issued_installation_tokens.expires_at
      FROM installation_token_issuance_audit_entries
      LEFT JOIN issued_installation_tokens
        ON issued_installation_tokens.audit_log_entry_id =
          installation_token_issuance_audit_entries.id
      WHERE installation_token_issuance_audit_entries.caller_repository_id = ?
      ORDER BY
        installation_token_issuance_audit_entries.requested_at DESC,
        installation_token_issuance_audit_entries.id DESC
      LIMIT ?
    `,
  )
    .bind(repositoryId, limit)
    .all<AuditRow>();

  return Promise.all(
    rows.results.map(async (row) => ({
      actor: row.github_actor,
      auditState: normalizeAuditState(row.audit_state),
      eventName: row.github_actions_event_name,
      expiresAt: row.expires_at,
      fullNameDisplay: row.caller_repository_full_name_display,
      id: row.id,
      installationId: row.installation_id,
      outcome: normalizeOutcome(row.outcome),
      permissions: await listAuditPermissions(env, row.id),
      reasons: await listAuditReasons(env, row.id),
      ref: row.github_ref,
      requestedAt: row.requested_at,
      workflowRef: row.github_workflow_ref,
    })),
  );
}

export async function listRepositoryAuditSummaries(
  env: Env,
  repositoryIds: number[],
): Promise<Map<number, RepositoryAuditSummary>> {
  const uniqueRepositoryIds = Array.from(new Set(repositoryIds));

  if (uniqueRepositoryIds.length === 0) {
    return new Map();
  }

  const summaries = new Map<number, RepositoryAuditSummary>();

  for (const chunk of chunks(uniqueRepositoryIds, 500)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `
        SELECT
          entries.caller_repository_id AS repository_id,
          MAX(entries.requested_at) AS last_installation_token_issuance_at,
          (
            SELECT latest.outcome
            FROM installation_token_issuance_audit_entries latest
            WHERE latest.caller_repository_id =
              entries.caller_repository_id
            ORDER BY latest.requested_at DESC, latest.id DESC
            LIMIT 1
          ) AS last_outcome
        FROM installation_token_issuance_audit_entries entries
        WHERE entries.caller_repository_id IN (${placeholders})
        GROUP BY entries.caller_repository_id
      `,
    )
      .bind(...chunk)
      .all<RepositoryAuditSummaryRow>();

    for (const row of rows.results) {
      summaries.set(row.repository_id, {
        lastInstallationTokenIssuanceAt: row.last_installation_token_issuance_at,
        lastOutcome: row.last_outcome,
      });
    }
  }

  return summaries;
}

async function listAuditPermissions(
  env: Env,
  auditEntryId: number,
): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    `
      SELECT permission_name, permission_access
      FROM issued_installation_token_permissions
      WHERE audit_log_entry_id = ?
      ORDER BY permission_name ASC
    `,
  )
    .bind(auditEntryId)
    .all<Record<"permission_access" | "permission_name", string>>();

  return Object.fromEntries(
    rows.results.map((row) => [row.permission_name, row.permission_access]),
  );
}

async function listAuditReasons(env: Env, auditEntryId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `
      SELECT outcome_reason
      FROM installation_token_issuance_audit_outcome_reasons
      WHERE audit_log_entry_id = ?
      ORDER BY outcome_reason ASC
    `,
  )
    .bind(auditEntryId)
    .all<Record<"outcome_reason", string>>();

  return rows.results.map((row) => row.outcome_reason);
}

function normalizeAuditState(value: string): RepositoryAuditEntryRecord["auditState"] {
  if (value === "pending" || value === "finalized" || value === "finalization_failed") {
    return value;
  }

  return "finalization_failed";
}

function normalizeOutcome(value: string | null): RepositoryAuditEntryRecord["outcome"] {
  if (
    value === null ||
    value === "denied" ||
    value === "internal_error" ||
    value === "issued" ||
    value === "upstream_error"
  ) {
    return value;
  }

  return "internal_error";
}

function normalizeRepositoryFullName(value: string): string {
  return value.trim().toLowerCase();
}

function parseRepositoryId(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("invalid GitHub repository id");
  }

  return parsed;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}
