import type { Env } from "../env.ts";
import type {
  GitHubApiDependencies,
  GitHubUserRepositoryAccess,
  GitHubUserAccessToken,
} from "../github/api.ts";
import {
  listGitHubUserInstallationRepositories,
  listGitHubUserInstallations,
} from "../github/api.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
import {
  dashboardSessionTokenHash,
  decryptValue,
  createEncryptedValue,
} from "../dashboard/auth.ts";

const dashboardIdleTtlMs = 2 * 60 * 60 * 1000;
const dashboardAbsoluteTtlMs = 8 * 60 * 60 * 1000;

export interface AuditIntent {
  id: number;
  requestedAt: string;
}

export interface DashboardSession {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  absoluteExpiresAt: string;
  githubLoginDisplay: string;
  githubUserId: string;
  id: number;
  idleExpiresAt: string;
}

export interface DashboardRepositoryListItem {
  archivedAt: string | null;
  fullNameDisplay: string;
  installationId: number;
  lastInstallationTokenIssuanceAt: string | null;
  lastOutcome: string | null;
  repositoryId: number;
  repositoryVisibility: string;
}

export interface DashboardRepository {
  archivedAt: string | null;
  fullNameDisplay: string;
  fullNameNormalized: string;
  repositoryId: number;
  repositoryVisibility: string;
}

export interface DashboardAuditEntry {
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

type SessionRow = Record<"encrypted_github_user_token_blob" | "github_user_id", string> &
  Record<
    | "absolute_expires_at"
    | "created_at"
    | "github_login_display"
    | "github_user_access_token_expires_at"
    | "idle_expires_at"
    | "session_revoked_after",
    string | null
  > &
  Record<"id", number>;

type RepositoryRow = Record<
  "full_name_display" | "full_name_normalized" | "repository_visibility",
  string
> &
  Record<"archived_at", string | null> &
  Record<"repository_id", number>;

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

export async function createDashboardSession(
  env: Env,
  input: {
    now: string;
    rawSessionToken: string;
    token: GitHubUserAccessToken;
    user: { id: string; login: string };
  },
): Promise<void> {
  const sessionTokenHash = await dashboardSessionTokenHash(env, input.rawSessionToken);
  const encryptedToken = await createEncryptedValue(env, input.token.accessToken);
  const nowMs = Date.parse(input.now);
  const idleExpiresAt = new Date(nowMs + dashboardIdleTtlMs).toISOString();
  const absoluteExpiresAt = new Date(nowMs + dashboardAbsoluteTtlMs).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO dashboard_users (
          github_user_id,
          github_login_display,
          last_github_auth_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(github_user_id) DO UPDATE SET
          github_login_display = excluded.github_login_display,
          last_github_auth_at = excluded.last_github_auth_at,
          updated_at = excluded.updated_at
      `,
    ).bind(input.user.id, input.user.login, input.now, input.now, input.now),
    env.DB.prepare(
      `
        INSERT INTO dashboard_sessions (
          session_token_hash,
          github_user_id,
          encrypted_github_user_token_blob,
          github_user_access_token_expires_at,
          github_user_refresh_token_expires_at,
          last_seen_at,
          idle_expires_at,
          absolute_expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).bind(
      sessionTokenHash,
      input.user.id,
      encryptedToken,
      input.token.accessTokenExpiresAt,
      input.token.refreshTokenExpiresAt,
      input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      input.now,
      input.now,
    ),
  ]);
}

export async function getDashboardSession(
  env: Env,
  rawSessionToken: string,
  now: string,
): Promise<DashboardSession | null> {
  const sessionTokenHash = await dashboardSessionTokenHash(env, rawSessionToken);
  const row = await env.DB.prepare(
    `
      SELECT
        dashboard_sessions.id,
        dashboard_sessions.github_user_id,
        dashboard_sessions.encrypted_github_user_token_blob,
        dashboard_sessions.github_user_access_token_expires_at,
        dashboard_sessions.idle_expires_at,
        dashboard_sessions.absolute_expires_at,
        dashboard_sessions.created_at,
        dashboard_users.github_login_display,
        dashboard_users.session_revoked_after
      FROM dashboard_sessions
      INNER JOIN dashboard_users
        ON dashboard_users.github_user_id = dashboard_sessions.github_user_id
      WHERE dashboard_sessions.session_token_hash = ?
      LIMIT 1
    `,
  )
    .bind(sessionTokenHash)
    .first<SessionRow>();

  if (row === null) {
    return null;
  }

  const expiresAt = effectiveSessionExpiresAt(row);

  if (
    Date.parse(expiresAt) <= Date.parse(now) ||
    (row.session_revoked_after !== null &&
      Date.parse(row.session_revoked_after) >= Date.parse(row.created_at ?? ""))
  ) {
    await deleteDashboardSession(env, rawSessionToken);
    return null;
  }

  const accessToken = await decryptValue(env, row.encrypted_github_user_token_blob);

  if (accessToken === null) {
    await deleteDashboardSession(env, rawSessionToken);
    return null;
  }

  const nextIdleExpiresAt = new Date(Date.parse(now) + dashboardIdleTtlMs).toISOString();

  await env.DB.prepare(
    `
      UPDATE dashboard_sessions
      SET last_seen_at = ?, idle_expires_at = ?, updated_at = ?
      WHERE id = ?
    `,
  )
    .bind(now, nextIdleExpiresAt, now, row.id)
    .run();

  return {
    accessToken,
    accessTokenExpiresAt: row.github_user_access_token_expires_at,
    absoluteExpiresAt: row.absolute_expires_at ?? "",
    githubLoginDisplay: row.github_login_display ?? "",
    githubUserId: row.github_user_id,
    id: row.id,
    idleExpiresAt: nextIdleExpiresAt,
  };
}

export async function deleteDashboardSession(env: Env, rawSessionToken: string): Promise<void> {
  const sessionTokenHash = await dashboardSessionTokenHash(env, rawSessionToken);

  await env.DB.prepare(`DELETE FROM dashboard_sessions WHERE session_token_hash = ?`)
    .bind(sessionTokenHash)
    .run();
}

export async function listAccessibleDashboardRepositories(
  env: Env,
  session: DashboardSession,
  dependencies: GitHubApiDependencies,
  now: string,
): Promise<DashboardRepositoryListItem[]> {
  const installations = await listGitHubUserInstallations(env, session.accessToken, dependencies);
  const repositoryAccesses: GitHubUserRepositoryAccess[] = [];

  for (const installation of installations) {
    const repositories = await listGitHubUserInstallationRepositories(
      env,
      session.accessToken,
      installation.id,
      dependencies,
    );
    await upsertDashboardRepositoryAccess(env, installation.id, repositories, now);
    repositoryAccesses.push(...repositories);
  }

  const auditSummaries = await listRepositoryAuditSummaries(
    env,
    repositoryAccesses.map((repository) => parseRepositoryId(repository.githubRepoId)),
  );

  return repositoryAccesses
    .map((repository) => {
      const repositoryId = parseRepositoryId(repository.githubRepoId);
      const auditSummary = auditSummaries.get(repositoryId);

      return {
        archivedAt: repository.archived ? now : null,
        fullNameDisplay: repository.fullName,
        installationId: repository.installationId,
        lastInstallationTokenIssuanceAt: auditSummary?.lastInstallationTokenIssuanceAt ?? null,
        lastOutcome: auditSummary?.lastOutcome ?? null,
        repositoryId,
        repositoryVisibility: repository.private ? "private" : "public",
      };
    })
    .sort(compareDashboardRepositoryListItems);
}

export async function getAccessibleDashboardRepositoryByFullName(
  env: Env,
  session: DashboardSession,
  owner: string,
  name: string,
  dependencies: GitHubApiDependencies,
  now: string,
): Promise<DashboardRepository | null> {
  const fullNameNormalized = normalizeRepositoryFullName(`${owner}/${name}`);
  const installations = await listGitHubUserInstallations(env, session.accessToken, dependencies);
  let visibleRepository: GitHubUserRepositoryAccess | null = null;

  for (const installation of installations) {
    const repositories = await listGitHubUserInstallationRepositories(
      env,
      session.accessToken,
      installation.id,
      dependencies,
    );
    await upsertDashboardRepositoryAccess(env, installation.id, repositories, now);

    visibleRepository ??=
      repositories.find(
        (repository) => normalizeRepositoryFullName(repository.fullName) === fullNameNormalized,
      ) ?? null;
  }

  if (visibleRepository === null) {
    return null;
  }

  const repository = await env.DB.prepare(
    `
      SELECT
        repository_id,
        full_name_display,
        full_name_normalized,
        repository_visibility,
        archived_at
      FROM github_repositories
      WHERE full_name_normalized = ?
        AND deleted_at IS NULL
      LIMIT 1
    `,
  )
    .bind(fullNameNormalized)
    .first<RepositoryRow>();

  if (repository === null) {
    return null;
  }

  return {
    archivedAt: repository.archived_at,
    fullNameDisplay: repository.full_name_display,
    fullNameNormalized: repository.full_name_normalized,
    repositoryId: repository.repository_id,
    repositoryVisibility: repository.repository_visibility,
  };
}

export async function listRepositoryAuditEntries(
  env: Env,
  repositoryId: number,
  limit: number,
): Promise<DashboardAuditEntry[]> {
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

export async function recordWebhookDelivery(
  env: Env,
  input: {
    accepted: boolean;
    deliveryId: string;
    event: string;
    installationId: number | null;
    metadata?: Record<string, string | number | boolean | null>;
    receivedAt: string;
    responseStatusCode: number;
    signatureValid: boolean;
  },
): Promise<void> {
  await env.DB.prepare(
    `
      INSERT OR IGNORE INTO webhook_delivery_log_entries (
        delivery_id,
        received_at,
        github_event,
        installation_id,
        delivery_accepted,
        webhook_signature_valid,
        response_status_code,
        delivery_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      input.deliveryId,
      input.receivedAt,
      input.event,
      input.installationId,
      input.accepted ? 1 : 0,
      input.signatureValid ? 1 : 0,
      input.responseStatusCode,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}

async function upsertDashboardRepositoryAccess(
  env: Env,
  installationId: number,
  repositories: GitHubUserRepositoryAccess[],
  checkedAt: string,
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
        INSERT INTO github_app_installations (
          installation_id,
          repository_selection,
          created_at,
          updated_at
        ) VALUES (?, 'unknown', ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `,
    ).bind(installationId, checkedAt, checkedAt),
  ];

  for (const repository of repositories) {
    const repositoryId = parseRepositoryId(repository.githubRepoId);
    const fullNameNormalized = normalizeRepositoryFullName(repository.fullName);

    statements.push(
      env.DB.prepare(
        `
          INSERT INTO github_repositories (
            repository_id,
            owner_login_display,
            repository_name_display,
            full_name_display,
            full_name_normalized,
            repository_visibility,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repository_id) DO UPDATE SET
            owner_login_display = excluded.owner_login_display,
            repository_name_display = excluded.repository_name_display,
            full_name_display = excluded.full_name_display,
            full_name_normalized = excluded.full_name_normalized,
            repository_visibility = excluded.repository_visibility,
            deleted_at = NULL,
            updated_at = excluded.updated_at
        `,
      ).bind(
        repositoryId,
        repository.ownerLogin,
        repository.name,
        repository.fullName,
        fullNameNormalized,
        repository.private ? "private" : "public",
        checkedAt,
        checkedAt,
      ),
      env.DB.prepare(
        `
          INSERT INTO github_app_installation_repositories (
            installation_id,
            repository_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(installation_id, repository_id) DO UPDATE SET
            updated_at = excluded.updated_at
        `,
      ).bind(installationId, repositoryId, checkedAt, checkedAt),
    );
  }

  await env.DB.batch(statements);
}

async function listRepositoryAuditSummaries(
  env: Env,
  repositoryIds: number[],
): Promise<
  Map<number, { lastInstallationTokenIssuanceAt: string | null; lastOutcome: string | null }>
> {
  const uniqueRepositoryIds = Array.from(new Set(repositoryIds));
  const visibleRepositoryIds = new Set(uniqueRepositoryIds);

  if (uniqueRepositoryIds.length === 0) {
    return new Map();
  }

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
      GROUP BY entries.caller_repository_id
    `,
  ).all<RepositoryAuditSummaryRow>();

  return new Map(
    rows.results
      .filter((row) => visibleRepositoryIds.has(row.repository_id))
      .map((row) => [
        row.repository_id,
        {
          lastInstallationTokenIssuanceAt: row.last_installation_token_issuance_at,
          lastOutcome: row.last_outcome,
        },
      ]),
  );
}

function compareDashboardRepositoryListItems(
  left: DashboardRepositoryListItem,
  right: DashboardRepositoryListItem,
): number {
  const leftArchived = left.archivedAt === null ? 0 : 1;
  const rightArchived = right.archivedAt === null ? 0 : 1;

  if (leftArchived !== rightArchived) {
    return leftArchived - rightArchived;
  }

  const leftLastIssuance = left.lastInstallationTokenIssuanceAt ?? "";
  const rightLastIssuance = right.lastInstallationTokenIssuanceAt ?? "";

  if (leftLastIssuance !== rightLastIssuance) {
    return rightLastIssuance.localeCompare(leftLastIssuance);
  }

  const fullNameComparison = left.fullNameDisplay.localeCompare(right.fullNameDisplay);

  if (fullNameComparison !== 0) {
    return fullNameComparison;
  }

  return left.installationId - right.installationId;
}

function effectiveSessionExpiresAt(row: SessionRow): string {
  const expiries = [
    row.idle_expires_at,
    row.absolute_expires_at,
    row.github_user_access_token_expires_at,
  ].filter((value): value is string => value !== null);

  return expiries.sort()[0] ?? new Date(0).toISOString();
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

function normalizeAuditState(value: string): DashboardAuditEntry["auditState"] {
  if (value === "pending" || value === "finalized" || value === "finalization_failed") {
    return value;
  }

  return "finalization_failed";
}

function normalizeOutcome(value: string | null): DashboardAuditEntry["outcome"] {
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
