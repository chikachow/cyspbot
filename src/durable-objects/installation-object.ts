import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import {
  authorizeTokenMintRequest,
  BrokerAuthorizationError,
  createRepositoryScopedInstallationToken,
  GitHubApiError,
} from "../github/api.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
import type { TokenMintPolicyDecision } from "../policy/token-mint-authorization.ts";

export interface ReceiveWebhookFailure {
  ok: false;
  status: number;
}

export interface ReceiveWebhookSuccess {
  accepted: true;
  ok: true;
}

export type ReceiveWebhookResult = ReceiveWebhookFailure | ReceiveWebhookSuccess;

export interface InstallationWebhookRequest {
  body: string;
  deliveryId: string;
  event: string;
  installationId: number;
  signature: string;
}

export interface MintInstallationTokenRequest {
  installationId: number;
  issuer: string;
  principal: GitHubActionsPrincipal;
  resolvedKeyId: string | null;
}

export interface MintInstallationTokenSuccess {
  expiresAt: string;
  ok: true;
  permissions: Record<string, string>;
  token: string;
}

export interface MintInstallationTokenFailure {
  ok: false;
  status: number;
}

export interface ListRepositoryTokenRequestsRequest {
  limit: number;
  repositoryId: string;
}

export interface RepositoryTokenRequestEntry {
  actor: string | null;
  eventName: string;
  expiresAt: string | null;
  id: number;
  mintedPermissions: Record<string, string>;
  oidcContext: Record<string, string | null> | null;
  outcome: "denied" | "internal_error" | "issued" | "upstream_error";
  policyReasons: string[];
  ref: string | null;
  timestamp: string;
}

export type MintInstallationTokenResult =
  | MintInstallationTokenFailure
  | MintInstallationTokenSuccess;

export interface RunMigrationsResult {
  ok: true;
}

type TokenRequestTableInfoRow = Record<"name", string>;

type LegacyTokenRequestRow = Record<"id" | "installation_id" | "status", number> &
  Record<
    | "actor"
    | "event_name"
    | "expires_at"
    | "minted_permissions_json"
    | "oidc_context_json"
    | "policy_decision"
    | "policy_decision_json"
    | "ref"
    | "repository"
    | "repository_id"
    | "requested_at"
    | "run_attempt"
    | "run_id"
    | "sha"
    | "workflow",
    string | null
  >;

type TokenRequestRow = Record<"id" | "installation_id", number> &
  Record<
    | "actor"
    | "event_name"
    | "expires_at"
    | "oidc_context_json"
    | "outcome"
    | "ref"
    | "repository"
    | "repository_id"
    | "timestamp",
    string | null
  >;

export class GitHubInstallationObject extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        ref TEXT,
        actor TEXT,
        outcome TEXT NOT NULL,
        expires_at TEXT,
        oidc_context_json TEXT
      )
    `);
    try {
      ctx.storage.sql.exec(`
        ALTER TABLE token_requests
        ADD COLUMN outcome TEXT
      `);
    } catch {
      // Column already exists in existing Durable Object storage.
    }
    try {
      ctx.storage.sql.exec(`
        ALTER TABLE token_requests
        ADD COLUMN oidc_context_json TEXT
      `);
    } catch {
      // Column already exists in existing Durable Object storage.
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_request_policy_reasons (
        token_request_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (token_request_id, reason)
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_request_minted_permissions (
        token_request_id INTEGER NOT NULL,
        permission_name TEXT NOT NULL,
        permission_access TEXT NOT NULL,
        PRIMARY KEY (token_request_id, permission_name)
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        signature TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `);
    migrateLegacyTokenRequestSchema(ctx.storage.sql);
  }

  public async mintInstallationToken(
    request: MintInstallationTokenRequest,
  ): Promise<MintInstallationTokenResult> {
    const { installationId, issuer, principal, resolvedKeyId } = request;
    const timestamp = new Date().toISOString();
    let authorizedByPolicy = false;

    try {
      await authorizeTokenMintRequest(this.env, principal);
      authorizedByPolicy = true;

      const token = await createRepositoryScopedInstallationToken(
        this.env,
        installationId,
        principal.repositoryId,
      );

      await this.recordAuditLog({
        principal,
        expiresAt: token.expiresAt,
        installationId,
        mintedPermissions: token.permissions,
        oidcContext: supplementalOidcContextForAudit(principal, issuer, resolvedKeyId),
        outcome: "issued",
        timestamp,
      });

      return {
        expiresAt: token.expiresAt,
        ok: true,
        permissions: token.permissions,
        token: token.token,
      };
    } catch (error) {
      const status = statusForTokenRequestError(error);
      const policyDecision =
        error instanceof BrokerAuthorizationError ? error.policyDecision : undefined;
      const outcome = outcomeForTokenRequestError(error, authorizedByPolicy);

      console.error("GitHub installation token request failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        eventName: principal.eventName,
        installationId,
        outcome,
        ref: principal.ref,
        repository: principal.repository,
        repositoryId: principal.repositoryId,
      });

      await this.recordAuditLog({
        principal,
        installationId,
        oidcContext: supplementalOidcContextForAudit(principal, issuer, resolvedKeyId),
        outcome,
        policyDenial:
          policyDecision === undefined ? undefined : summarizePolicyDecision(policyDecision),
        timestamp,
      });

      return {
        ok: false,
        status,
      };
    }
  }

  public async receiveWebhook(request: InstallationWebhookRequest): Promise<ReceiveWebhookResult> {
    const { body, deliveryId, event, installationId, signature } = request;
    if (
      typeof body !== "string" ||
      typeof deliveryId !== "string" ||
      typeof event !== "string" ||
      typeof signature !== "string" ||
      !Number.isInteger(installationId)
    ) {
      return {
        ok: false,
        status: 400,
      };
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO webhook_requests (
          received_at,
          installation_id,
          delivery_id,
          event,
          signature,
          body
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      new Date().toISOString(),
      installationId,
      deliveryId,
      event,
      signature,
      body,
    );

    this.pruneWebhookLog();

    return {
      accepted: true,
      ok: true,
    };
  }

  public async runMigrations(): Promise<RunMigrationsResult> {
    return { ok: true };
  }

  public async listRepositoryTokenRequests(
    request: ListRepositoryTokenRequestsRequest,
  ): Promise<RepositoryTokenRequestEntry[]> {
    const limit = Math.max(1, Math.min(request.limit, 20));
    const rows = this.ctx.storage.sql
      .exec<TokenRequestRow>(
        `
          SELECT
            id,
            installation_id,
            repository_id,
            repository,
            event_name,
            ref,
            actor,
            outcome,
            expires_at,
            oidc_context_json,
            timestamp
          FROM token_requests
          WHERE repository_id = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        `,
        request.repositoryId,
        limit,
      )
      .toArray();

    return rows.map((row) => ({
      actor: row.actor,
      eventName: row.event_name ?? "",
      expiresAt: row.expires_at,
      id: row.id,
      mintedPermissions: this.listMintedPermissions(row.id),
      oidcContext: parseOidcContext(row.oidc_context_json),
      outcome: normalizeOutcome(row.outcome),
      policyReasons: this.listPolicyReasons(row.id),
      ref: row.ref,
      timestamp: row.timestamp ?? "",
    }));
  }

  private listMintedPermissions(tokenRequestId: number): Record<string, string> {
    return Object.fromEntries(
      this.ctx.storage.sql
        .exec<Record<"permission_access" | "permission_name", string>>(
          `
            SELECT permission_name, permission_access
            FROM token_request_minted_permissions
            WHERE token_request_id = ?
            ORDER BY permission_name ASC
          `,
          tokenRequestId,
        )
        .toArray()
        .map((row) => [row.permission_name, row.permission_access]),
    );
  }

  private listPolicyReasons(tokenRequestId: number): string[] {
    return listRows(
      this.ctx.storage.sql,
      `
        SELECT reason AS value
        FROM token_request_policy_reasons
        WHERE token_request_id = ?
        ORDER BY reason ASC
      `,
      tokenRequestId,
    );
  }

  private async recordAuditLog(entry: {
    principal: GitHubActionsPrincipal;
    expiresAt?: string;
    installationId: number;
    mintedPermissions?: Record<string, string>;
    oidcContext?: Record<string, string | null>;
    outcome: "denied" | "issued" | "upstream_error" | "internal_error";
    policyDenial?: {
      reasons: string[];
    };
    timestamp: string;
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO token_requests (
          timestamp,
          repository_id,
          repository,
          installation_id,
          event_name,
          ref,
          actor,
          outcome,
          expires_at,
          oidc_context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      entry.timestamp,
      entry.principal.repositoryId,
      entry.principal.repository,
      entry.installationId,
      entry.principal.eventName,
      entry.principal.ref,
      entry.principal.actor,
      entry.outcome,
      entry.expiresAt ?? null,
      entry.oidcContext === undefined ? null : JSON.stringify(entry.oidcContext),
    );
    const tokenRequestId = this.ctx.storage.sql
      .exec<{ id: number }>(`SELECT last_insert_rowid() AS id`)
      .one().id;

    if (entry.policyDenial !== undefined) {
      for (const reason of entry.policyDenial.reasons) {
        this.ctx.storage.sql.exec(
          `
            INSERT OR IGNORE INTO token_request_policy_reasons (
              token_request_id,
              reason
            ) VALUES (?, ?)
          `,
          tokenRequestId,
          reason,
        );
      }
    }

    if (entry.mintedPermissions !== undefined) {
      for (const [permissionName, permissionAccess] of Object.entries(entry.mintedPermissions)) {
        this.ctx.storage.sql.exec(
          `
            INSERT OR REPLACE INTO token_request_minted_permissions (
              token_request_id,
              permission_name,
              permission_access
            ) VALUES (?, ?, ?)
          `,
          tokenRequestId,
          permissionName,
          permissionAccess,
        );
      }
    }

    this.pruneAuditLog();
  }

  private pruneAuditLog(): void {
    const retentionDays = parsePositiveInteger(this.env.AUDIT_LOG_RETENTION_DAYS, 180);
    const maxEntries = parsePositiveInteger(this.env.AUDIT_LOG_MAX_ENTRIES, 5000);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    this.ctx.storage.sql.exec(`DELETE FROM token_requests WHERE timestamp < ?`, cutoff);
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_request_policy_reasons
        WHERE token_request_id NOT IN (
          SELECT id FROM token_requests
        )
      `,
    );
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_request_minted_permissions
        WHERE token_request_id NOT IN (
          SELECT id FROM token_requests
        )
      `,
    );
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_requests
        WHERE id NOT IN (
          SELECT id FROM token_requests
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        )
      `,
      maxEntries,
    );
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_request_policy_reasons
        WHERE token_request_id NOT IN (
          SELECT id FROM token_requests
        )
      `,
    );
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_request_minted_permissions
        WHERE token_request_id NOT IN (
          SELECT id FROM token_requests
        )
      `,
    );
  }

  private pruneWebhookLog(): void {
    const retentionDays = parsePositiveInteger(this.env.AUDIT_LOG_RETENTION_DAYS, 180);
    const maxEntries = parsePositiveInteger(this.env.AUDIT_LOG_MAX_ENTRIES, 5000);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    this.ctx.storage.sql.exec(`DELETE FROM webhook_requests WHERE received_at < ?`, cutoff);
    this.ctx.storage.sql.exec(
      `
        DELETE FROM webhook_requests
        WHERE id NOT IN (
          SELECT id FROM webhook_requests
          ORDER BY received_at DESC, id DESC
          LIMIT ?
        )
      `,
      maxEntries,
    );
  }
}

function listRows(sql: SqlStorage, query: string, ...bindings: unknown[]): string[] {
  return sql
    .exec<Record<"value", string>>(query, ...bindings)
    .toArray()
    .map((row) => row.value);
}

function normalizeOutcome(
  outcome: string | null,
): "denied" | "internal_error" | "issued" | "upstream_error" {
  if (
    outcome === "denied" ||
    outcome === "internal_error" ||
    outcome === "issued" ||
    outcome === "upstream_error"
  ) {
    return outcome;
  }

  return "internal_error";
}

function parseOidcContext(value: string | null): Record<string, string | null> | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      ([, entry]) => entry === null || typeof entry === "string",
    );

    return Object.fromEntries(entries) as Record<string, string | null>;
  } catch {
    return null;
  }
}

function supplementalOidcContextForAudit(
  principal: GitHubActionsPrincipal,
  issuer: string,
  resolvedKeyId: string | null,
): Record<string, string | null> {
  return {
    base_ref: principal.baseRef,
    environment: principal.environment,
    head_ref: principal.headRef,
    issuer,
    job_workflow_ref: principal.jobWorkflowRef,
    raw_subject: principal.rawSubject,
    ref_type: principal.refType,
    repository_owner_id: principal.repositoryOwnerId,
    repository_visibility: principal.repositoryVisibility,
    resolved_key_id: resolvedKeyId,
    run_attempt: principal.runAttempt,
    run_id: principal.runId,
    sha: principal.sha,
    subject_context_kind: principal.subjectContextKind,
    subject_context_value: principal.subjectContextValue,
    subject_repository: principal.subjectRepository,
    workflow: principal.workflow,
    workflow_ref: principal.workflowRef,
  };
}

function summarizePolicyDecision(policyDecision: TokenMintPolicyDecision): {
  reasons: string[];
} {
  return {
    reasons: policyDecision.reasons,
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function migrateLegacyTokenRequestSchema(sql: SqlStorage): void {
  const columns = sql
    .exec<TokenRequestTableInfoRow>(`PRAGMA table_info(token_requests)`)
    .toArray()
    .map((row) => row.name);

  const hasLegacyMintedPermissions = columns.includes("minted_permissions_json");
  const hasLegacyPolicyDecisionJson = columns.includes("policy_decision_json");
  const hasLegacyPolicyDecision = columns.includes("policy_decision");
  const hasLegacyRequestedAt = columns.includes("requested_at");
  const hasLegacyStatus = columns.includes("status");
  const hasLegacyWorkflowColumns =
    columns.includes("workflow") ||
    columns.includes("run_id") ||
    columns.includes("run_attempt") ||
    columns.includes("sha");

  if (
    !hasLegacyMintedPermissions &&
    !hasLegacyPolicyDecisionJson &&
    !hasLegacyPolicyDecision &&
    !hasLegacyRequestedAt &&
    !hasLegacyStatus &&
    !hasLegacyWorkflowColumns
  ) {
    return;
  }

  if (!hasLegacyRequestedAt && columns.includes("timestamp") && columns.includes("outcome")) {
    sql.exec(`
      CREATE TABLE token_requests_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        ref TEXT,
        actor TEXT,
        outcome TEXT NOT NULL,
        expires_at TEXT,
        oidc_context_json TEXT
      )
    `);
    sql.exec(`
      INSERT INTO token_requests_v2 (
        id,
        timestamp,
        repository_id,
        repository,
        installation_id,
        event_name,
        ref,
        actor,
        outcome,
        expires_at,
        oidc_context_json
      )
      SELECT
        id,
        timestamp,
        repository_id,
        repository,
        installation_id,
        event_name,
        ref,
        actor,
        outcome,
        expires_at,
        oidc_context_json
      FROM token_requests
    `);
    sql.exec(`DROP TABLE token_requests`);
    sql.exec(`ALTER TABLE token_requests_v2 RENAME TO token_requests`);
    return;
  }

  const legacySelect = `
    SELECT
      ${legacyColumnExpression(columns, "actor")},
      ${legacyColumnExpression(columns, "event_name")},
      ${legacyColumnExpression(columns, "expires_at")},
      id,
      installation_id,
      ${legacyColumnExpression(columns, "minted_permissions_json")},
      ${legacyColumnExpression(columns, "oidc_context_json")},
      ${legacyColumnExpression(columns, "policy_decision")},
      ${legacyColumnExpression(columns, "policy_decision_json")},
      ${legacyColumnExpression(columns, "ref")},
      ${legacyColumnExpression(columns, "repository")},
      ${legacyColumnExpression(columns, "repository_id")},
      ${legacyTimestampExpression(columns)},
      ${legacyColumnExpression(columns, "run_attempt")},
      ${legacyColumnExpression(columns, "run_id")},
      ${legacyColumnExpression(columns, "sha")},
      ${legacyColumnExpression(columns, "status")},
      ${legacyColumnExpression(columns, "workflow")}
    FROM token_requests
  `;

  for (const row of sql.exec<LegacyTokenRequestRow>(legacySelect).toArray()) {
    if (row.minted_permissions_json !== null) {
      const mintedPermissions = parseLegacyStringRecordJson(row.minted_permissions_json);

      if (mintedPermissions !== null) {
        for (const [permissionName, permissionAccess] of Object.entries(mintedPermissions)) {
          sql.exec(
            `
              INSERT OR REPLACE INTO token_request_minted_permissions (
                token_request_id,
                permission_name,
                permission_access
              ) VALUES (?, ?, ?)
            `,
            row.id,
            permissionName,
            permissionAccess,
          );
        }
      }
    }

    if (row.policy_decision_json !== null) {
      const policyDenial = parseLegacyPolicyDecisionJson(row.policy_decision_json);

      if (policyDenial !== null) {
        for (const reason of policyDenial.reasons) {
          sql.exec(
            `
              INSERT OR IGNORE INTO token_request_policy_reasons (
                token_request_id,
                reason
              ) VALUES (?, ?)
            `,
            row.id,
            reason,
          );
        }
      }
    }
  }

  sql.exec(`
    CREATE TABLE token_requests_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      installation_id INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      ref TEXT,
      actor TEXT,
      outcome TEXT NOT NULL,
      expires_at TEXT,
      oidc_context_json TEXT
    )
  `);
  sql.exec(`
    INSERT INTO token_requests_v2 (
      id,
      timestamp,
      repository_id,
      repository,
      installation_id,
      event_name,
      ref,
      actor,
      outcome,
      expires_at,
      oidc_context_json
    )
    SELECT
      id,
      ${legacyTimestampSourceExpression(columns)},
      repository_id,
      repository,
      installation_id,
      event_name,
      ref,
      actor,
      CASE
        WHEN ${legacyStatusComparisonExpression(columns, 200)} THEN 'issued'
        WHEN ${legacyPolicyDenyExpression(columns)} THEN 'denied'
        WHEN ${legacyPolicyAllowExpression(columns)} THEN 'upstream_error'
        ELSE 'internal_error'
      END,
      expires_at,
      json_patch(
        COALESCE(oidc_context_json, '{}'),
        json_object(
          'workflow', ${legacyColumnSourceExpression(columns, "workflow")},
          'run_id', ${legacyColumnSourceExpression(columns, "run_id")},
          'run_attempt', ${legacyColumnSourceExpression(columns, "run_attempt")},
          'sha', ${legacyColumnSourceExpression(columns, "sha")}
        )
      )
    FROM token_requests
  `);
  sql.exec(`DROP TABLE token_requests`);
  sql.exec(`ALTER TABLE token_requests_v2 RENAME TO token_requests`);
}

function legacyColumnExpression(columns: string[], columnName: string): string {
  if (columns.includes(columnName)) {
    return columnName;
  }

  return `NULL AS ${columnName}`;
}

function legacyColumnSourceExpression(columns: string[], columnName: string): string {
  if (columns.includes(columnName)) {
    return columnName;
  }

  return "NULL";
}

function legacyTimestampExpression(columns: string[]): string {
  if (columns.includes("requested_at")) {
    return "requested_at";
  }

  if (columns.includes("timestamp")) {
    return "timestamp AS requested_at";
  }

  return "NULL AS requested_at";
}

function legacyTimestampSourceExpression(columns: string[]): string {
  if (columns.includes("requested_at")) {
    return "requested_at";
  }

  if (columns.includes("timestamp")) {
    return "timestamp";
  }

  return "CURRENT_TIMESTAMP";
}

function legacyStatusComparisonExpression(columns: string[], status: number): string {
  if (!columns.includes("status")) {
    return "0";
  }

  return `status = ${status}`;
}

function legacyPolicyDenyExpression(columns: string[]): string {
  const denyConditions: string[] = [];

  if (columns.includes("policy_decision")) {
    denyConditions.push(`policy_decision = 'deny'`);
  }

  if (columns.includes("policy_decision_json")) {
    denyConditions.push("policy_decision_json IS NOT NULL");
  }

  if (denyConditions.length === 0) {
    return "0";
  }

  return `(${denyConditions.join(" OR ")})`;
}

function legacyPolicyAllowExpression(columns: string[]): string {
  if (!columns.includes("policy_decision")) {
    return "0";
  }

  return `policy_decision = 'allow'`;
}

function parseLegacyPolicyDecisionJson(value: string): { reasons: string[] } | null {
  try {
    const parsed = JSON.parse(value) as { reasons?: unknown };

    if (!Array.isArray(parsed.reasons)) {
      return null;
    }

    const reasons = parsed.reasons.filter((reason): reason is string => typeof reason === "string");

    return {
      reasons: [...new Set(reasons)],
    };
  } catch {
    return null;
  }
}

function parseLegacyStringRecordJson(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );

    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function statusForTokenRequestError(error: unknown): number {
  if (error instanceof BrokerAuthorizationError) {
    return 403;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 400) {
      return 500;
    }

    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return 403;
    }

    if (error.status >= 500) {
      return 502;
    }
  }

  return 500;
}

function outcomeForTokenRequestError(
  error: unknown,
  authorizedByPolicy: boolean,
): "denied" | "internal_error" | "upstream_error" {
  if (error instanceof BrokerAuthorizationError) {
    return "denied";
  }

  if (authorizedByPolicy) {
    return "upstream_error";
  }

  return "internal_error";
}
