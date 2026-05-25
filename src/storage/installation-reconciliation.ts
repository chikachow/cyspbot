import type { Env } from "../env.ts";

export async function recordInstallationReconciliationSignal(
  env: Env,
  input: {
    installationId: number;
    requestedAt: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `
      INSERT INTO installation_reconciliation_states (
        installation_id,
        reconciliation_state,
        reconciliation_requested,
        last_requested_at,
        updated_at
      ) VALUES (?, 'pending', 1, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        reconciliation_requested = 1,
        last_requested_at = excluded.last_requested_at,
        reconciliation_state = CASE
          WHEN reconciliation_state = 'running' THEN reconciliation_state
          ELSE 'pending'
        END,
        updated_at = excluded.updated_at
    `,
  )
    .bind(input.installationId, input.requestedAt, input.requestedAt)
    .run();
}
