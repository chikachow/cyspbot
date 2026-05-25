import type { SignalInstallationReconciliationResult } from "../durable-objects/installation-object.ts";
import type { Env } from "../env.ts";
import { recordWebhookDelivery } from "../storage/webhook-delivery-log.ts";
import { verifyGitHubWebhookSignature } from "./signature.ts";

const maxWebhookBodyBytes = 256 * 1024;

interface InstallationWebhookPayload {
  installation?: {
    id?: number;
  };
}

export interface WebhookDeliveryAcceptanceDependencies {
  now(): Date;
}

export type WebhookDeliveryAcceptanceResult =
  | {
      body: { accepted: true; event?: string };
      kind: "accepted";
      status: 202;
    }
  | {
      kind: "rejected";
      status: number;
    };

export async function acceptGitHubWebhookDelivery(
  request: Request,
  env: Env,
  dependencies: WebhookDeliveryAcceptanceDependencies,
): Promise<WebhookDeliveryAcceptanceResult> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  const receivedAt = dependencies.now().toISOString();

  if (secret === undefined || secret.length === 0) {
    console.error("webhook_receiver_not_configured", { occurred_at: receivedAt });
    return rejected(500);
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return rejected(415);
  }

  const contentLength = request.headers.get("content-length");

  if (contentLength !== null) {
    const parsedContentLength = Number.parseInt(contentLength, 10);

    if (!Number.isSafeInteger(parsedContentLength) || parsedContentLength < 0) {
      return rejected(400);
    }

    if (parsedContentLength > maxWebhookBodyBytes) {
      return rejected(413);
    }
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  if (bodyBytes.byteLength > maxWebhookBodyBytes) {
    return rejected(413);
  }

  if (event === null || deliveryId === null || signatureHeader === null) {
    return rejected(400);
  }

  const signatureValid = await verifyGitHubWebhookSignature(bodyBytes, signatureHeader, secret);

  if (!signatureValid) {
    await recordWebhookDelivery(env, {
      accepted: false,
      deliveryId,
      event,
      installationId: null,
      receivedAt,
      responseStatusCode: 401,
      signatureValid: false,
    });

    return rejected(401);
  }

  let payload: InstallationWebhookPayload;

  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as InstallationWebhookPayload;
  } catch {
    await recordWebhookDelivery(env, {
      accepted: false,
      deliveryId,
      event,
      installationId: null,
      receivedAt,
      responseStatusCode: 400,
      signatureValid: true,
    });

    return rejected(400);
  }

  if (event === "ping") {
    await recordWebhookDelivery(env, {
      accepted: true,
      deliveryId,
      event,
      installationId: null,
      receivedAt,
      responseStatusCode: 202,
      signatureValid: true,
    });

    return accepted({ accepted: true, event });
  }

  const installationId = payload.installation?.id;

  if (!Number.isInteger(installationId) || installationId === undefined || installationId <= 0) {
    await recordWebhookDelivery(env, {
      accepted: false,
      deliveryId,
      event,
      installationId: null,
      receivedAt,
      responseStatusCode: 400,
      signatureValid: true,
    });

    return rejected(400);
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(installationId));
  const result = (await stub.signalInstallationReconciliation({
    installationId,
    signalSource: "webhook",
  })) as SignalInstallationReconciliationResult;

  if (!result.ok) {
    await recordWebhookDelivery(env, {
      accepted: false,
      deliveryId,
      event,
      installationId,
      receivedAt,
      responseStatusCode: result.status,
      signatureValid: true,
    });

    return rejected(result.status);
  }

  await recordWebhookDelivery(env, {
    accepted: true,
    deliveryId,
    event,
    installationId,
    metadata: { signal_source: "webhook" },
    receivedAt,
    responseStatusCode: 202,
    signatureValid: true,
  });

  return accepted({ accepted: true });
}

function accepted(body: { accepted: true; event?: string }): WebhookDeliveryAcceptanceResult {
  return {
    body,
    kind: "accepted",
    status: 202,
  };
}

function rejected(status: number): WebhookDeliveryAcceptanceResult {
  return {
    kind: "rejected",
    status,
  };
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
