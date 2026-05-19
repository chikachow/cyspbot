import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import {
  BrokerAuthorizationError,
  createRepositoryScopedInstallationToken,
  GitHubApiError,
  assertTokenMintPolicy,
} from "../github/api.ts";
import type { VerifiedCaller } from "../github/oidc.ts";
import { jsonResponse, problemResponse } from "../worker/problem-details.ts";

interface MintTokenRequest {
  caller: VerifiedCaller;
  installationId: number;
}

export class GitHubInstallationObject extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_at TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        ref TEXT,
        actor TEXT,
        workflow TEXT,
        run_id TEXT,
        run_attempt TEXT,
        sha TEXT,
        status INTEGER NOT NULL,
        expires_at TEXT
      )
    `);
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/token") {
      return problemResponse(404);
    }

    const { caller, installationId } = (await request.json()) as MintTokenRequest;
    const requestedAt = new Date().toISOString();

    try {
      await assertTokenMintPolicy(this.env, caller);

      const token = await createRepositoryScopedInstallationToken(
        this.env,
        installationId,
        caller.repositoryId,
      );

      await this.recordAuditLog({
        caller,
        expiresAt: token.expiresAt,
        installationId,
        requestedAt,
        status: 200,
      });

      return jsonResponse(
        {
          expires_at: token.expiresAt,
          token: token.token,
        },
        { status: 200 },
      );
    } catch (error) {
      const status = statusForTokenRequestError(error);

      console.error("GitHub installation token request failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        eventName: caller.eventName,
        installationId,
        mappedStatus: status,
        ref: caller.ref,
        repository: caller.repository,
        repositoryId: caller.repositoryId,
      });

      await this.recordAuditLog({
        caller,
        installationId,
        requestedAt,
        status,
      });

      return problemResponse(status);
    }
  }

  private async recordAuditLog(entry: {
    caller: VerifiedCaller;
    expiresAt?: string;
    installationId: number;
    requestedAt: string;
    status: number;
  }): Promise<void> {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO token_requests (
          requested_at,
          repository_id,
          repository,
          installation_id,
          event_name,
          ref,
          actor,
          workflow,
          run_id,
          run_attempt,
          sha,
          status,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      entry.requestedAt,
      entry.caller.repositoryId,
      entry.caller.repository,
      entry.installationId,
      entry.caller.eventName,
      entry.caller.ref,
      entry.caller.actor,
      entry.caller.workflow,
      entry.caller.runId,
      entry.caller.runAttempt,
      entry.caller.sha,
      entry.status,
      entry.expiresAt ?? null,
    );

    this.pruneAuditLog();
  }

  private pruneAuditLog(): void {
    const retentionDays = parsePositiveInteger(this.env.AUDIT_LOG_RETENTION_DAYS, 180);
    const maxEntries = parsePositiveInteger(this.env.AUDIT_LOG_MAX_ENTRIES, 5000);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    this.ctx.storage.sql.exec(`DELETE FROM token_requests WHERE requested_at < ?`, cutoff);
    this.ctx.storage.sql.exec(
      `
        DELETE FROM token_requests
        WHERE id NOT IN (
          SELECT id FROM token_requests
          ORDER BY requested_at DESC, id DESC
          LIMIT ?
        )
      `,
      maxEntries,
    );
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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
