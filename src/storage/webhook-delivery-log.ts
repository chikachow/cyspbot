import type { Env } from "../env.ts";

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
