import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import {
  BrokerAuthorizationError,
  createRepositoryScopedInstallationToken,
  GitHubApiError,
  assertTokenMintPolicy,
} from "../github/api.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
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
  principal: GitHubActionsPrincipal;
}

export interface MintInstallationTokenSuccess {
  expiresAt: string;
  ok: true;
  token: string;
}

export interface MintInstallationTokenFailure {
  ok: false;
  status: number;
}

export type MintInstallationTokenResult =
  | MintInstallationTokenFailure
  | MintInstallationTokenSuccess;

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
  }

  public async mintInstallationToken(
    request: MintInstallationTokenRequest,
  ): Promise<MintInstallationTokenResult> {
    const { installationId, principal } = request;
    const requestedAt = new Date().toISOString();

    try {
      await assertTokenMintPolicy(this.env, principal);

      const token = await createRepositoryScopedInstallationToken(
        this.env,
        installationId,
        principal.repositoryId,
      );

      await this.recordAuditLog({
        principal,
        expiresAt: token.expiresAt,
        installationId,
        requestedAt,
        status: 200,
      });

      return {
        expiresAt: token.expiresAt,
        ok: true,
        token: token.token,
      };
    } catch (error) {
      const status = statusForTokenRequestError(error);

      console.error("GitHub installation token request failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
        eventName: principal.eventName,
        installationId,
        mappedStatus: status,
        ref: principal.ref,
        repository: principal.repository,
        repositoryId: principal.repositoryId,
      });

      await this.recordAuditLog({
        principal,
        installationId,
        requestedAt,
        status,
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

  private async recordAuditLog(entry: {
    principal: GitHubActionsPrincipal;
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
      entry.principal.repositoryId,
      entry.principal.repository,
      entry.installationId,
      entry.principal.eventName,
      entry.principal.ref,
      entry.principal.actor,
      entry.principal.workflow,
      entry.principal.runId,
      entry.principal.runAttempt,
      entry.principal.sha,
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
