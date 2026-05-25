import type { Env } from "../env.ts";
import type { GitHubUserAccessToken } from "../github/api.ts";
import {
  dashboardSessionTokenHash,
  decryptValue,
  createEncryptedValue,
} from "../dashboard/auth.ts";

const dashboardIdleTtlMs = 2 * 60 * 60 * 1000;
const dashboardAbsoluteTtlMs = 8 * 60 * 60 * 1000;

export interface DashboardSessionRecord {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  absoluteExpiresAt: string;
  githubLoginDisplay: string;
  githubUserId: string;
  id: number;
  idleExpiresAt: string;
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
): Promise<DashboardSessionRecord | null> {
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

function effectiveSessionExpiresAt(row: SessionRow): string {
  const expiries = [
    row.idle_expires_at,
    row.absolute_expires_at,
    row.github_user_access_token_expires_at,
  ].filter((value): value is string => value !== null);

  return expiries.sort()[0] ?? new Date(0).toISOString();
}
