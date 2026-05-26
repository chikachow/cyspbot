import type { Env } from "../env.ts";

export interface PullRequestHaikuCommentState {
  commentId: number | null;
  currentHeadSha: string | null;
  lastRenderedHeadSha: string | null;
}

export async function listPullRequestHaikuRepositoryOptIns(env: Env): Promise<Set<number>> {
  const rows = await env.DB.prepare(
    `
      SELECT repository_id
      FROM pull_request_haiku_repository_opt_ins
    `,
  ).all<{ repository_id: number }>();

  return new Set(rows.results.map((row) => row.repository_id));
}

export async function pullRequestHaikuRepositoryOptedIn(
  env: Env,
  repositoryId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT 1 AS opted_in
      FROM pull_request_haiku_repository_opt_ins
      WHERE repository_id = ?
    `,
  )
    .bind(repositoryId)
    .first<{ opted_in: number }>();

  return row !== null;
}

export async function setPullRequestHaikuRepositoryOptIn(
  env: Env,
  input: {
    enabled: boolean;
    enabledAt: string;
    enabledBy: string;
    repositoryFullName: string;
    repositoryId: number;
  },
): Promise<void> {
  if (!input.enabled) {
    await env.DB.prepare(
      `
        DELETE FROM pull_request_haiku_repository_opt_ins
        WHERE repository_id = ?
      `,
    )
      .bind(input.repositoryId)
      .run();
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO pull_request_haiku_repository_opt_ins (
        repository_id,
        repository_full_name_display,
        enabled_at,
        enabled_by
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        repository_full_name_display = excluded.repository_full_name_display,
        enabled_at = excluded.enabled_at,
        enabled_by = excluded.enabled_by
    `,
  )
    .bind(input.repositoryId, input.repositoryFullName, input.enabledAt, input.enabledBy)
    .run();
}

export async function recordPullRequestHaikuQueued(
  env: Env,
  input: {
    action: string;
    deliveryId: string;
    headSha: string;
    installationId: number;
    pullRequestNumber: number;
    queuedAt: string;
    repositoryFullName: string;
    repositoryId: number;
  },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO pull_request_haiku_comments (
          repository_id,
          pull_request_number,
          repository_full_name_display,
          current_head_sha,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository_id, pull_request_number) DO UPDATE SET
          repository_full_name_display = excluded.repository_full_name_display,
          current_head_sha = excluded.current_head_sha,
          updated_at = excluded.updated_at
      `,
    ).bind(
      input.repositoryId,
      input.pullRequestNumber,
      input.repositoryFullName,
      input.headSha,
      input.queuedAt,
    ),
    env.DB.prepare(
      `
        INSERT OR IGNORE INTO pull_request_haiku_runs (
          delivery_id,
          repository_id,
          repository_full_name_display,
          pull_request_number,
          installation_id,
          action,
          head_sha,
          run_status,
          queued_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
    ).bind(
      input.deliveryId,
      input.repositoryId,
      input.repositoryFullName,
      input.pullRequestNumber,
      input.installationId,
      input.action,
      input.headSha,
      input.queuedAt,
      input.queuedAt,
    ),
  ]);
}

export async function getPullRequestHaikuCommentState(
  env: Env,
  input: {
    pullRequestNumber: number;
    repositoryId: number;
  },
): Promise<PullRequestHaikuCommentState | null> {
  const row = await env.DB.prepare(
    `
      SELECT comment_id, current_head_sha, last_rendered_head_sha
      FROM pull_request_haiku_comments
      WHERE repository_id = ? AND pull_request_number = ?
    `,
  )
    .bind(input.repositoryId, input.pullRequestNumber)
    .first<{
      comment_id: number | null;
      current_head_sha: string | null;
      last_rendered_head_sha: string | null;
    }>();

  if (row === null) {
    return null;
  }

  return {
    commentId: row.comment_id,
    currentHeadSha: row.current_head_sha,
    lastRenderedHeadSha: row.last_rendered_head_sha,
  };
}

export async function markPullRequestHaikuRunStarted(
  env: Env,
  input: { deliveryId: string; startedAt: string },
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE pull_request_haiku_runs
      SET run_status = 'running',
          started_at = ?,
          updated_at = ?
      WHERE delivery_id = ?
    `,
  )
    .bind(input.startedAt, input.startedAt, input.deliveryId)
    .run();
}

export async function markPullRequestHaikuRunSkipped(
  env: Env,
  input: { deliveryId: string; errorCode: string; finishedAt: string },
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE pull_request_haiku_runs
      SET run_status = 'skipped',
          completed_at = ?,
          error_code = ?,
          updated_at = ?
      WHERE delivery_id = ?
    `,
  )
    .bind(input.finishedAt, input.errorCode, input.finishedAt, input.deliveryId)
    .run();
}

export async function markPullRequestHaikuRunFailed(
  env: Env,
  input: { deliveryId: string; errorCode: string; errorMessage: string; failedAt: string },
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE pull_request_haiku_runs
      SET run_status = 'failed',
          completed_at = ?,
          error_code = ?,
          error_message = ?,
          updated_at = ?
      WHERE delivery_id = ?
    `,
  )
    .bind(
      input.failedAt,
      input.errorCode,
      input.errorMessage.slice(0, 1000),
      input.failedAt,
      input.deliveryId,
    )
    .run();
}

export async function markPullRequestHaikuRunSucceeded(
  env: Env,
  input: {
    aiModel: string | null;
    commentId: number;
    deliveryId: string;
    finishedAt: string;
    headSha: string;
    outputKind: "markdown";
    pullRequestNumber: number;
    repositoryId: number;
  },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `
        UPDATE pull_request_haiku_comments
        SET comment_id = ?,
            last_rendered_head_sha = ?,
            updated_at = ?
        WHERE repository_id = ? AND pull_request_number = ?
      `,
    ).bind(
      input.commentId,
      input.headSha,
      input.finishedAt,
      input.repositoryId,
      input.pullRequestNumber,
    ),
    env.DB.prepare(
      `
        UPDATE pull_request_haiku_runs
        SET run_status = 'succeeded',
            completed_at = ?,
            comment_id = ?,
            ai_model = ?,
            output_kind = ?,
            updated_at = ?
        WHERE delivery_id = ?
      `,
    ).bind(
      input.finishedAt,
      input.commentId,
      input.aiModel,
      input.outputKind,
      input.finishedAt,
      input.deliveryId,
    ),
  ]);
}
