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

type WebhookAcceptedBody = { accepted: true; event?: string };

interface AcceptedWebhookDeliveryLogInput {
  body: WebhookAcceptedBody;
  installationId: number | null;
  metadata?: Record<string, string | number | boolean | null>;
}

interface RejectedWebhookDeliveryLogInput {
  installationId: number | null;
  signatureValid: boolean;
  status: number;
}

interface WebhookDeliveryLogContext {
  deliveryId: string;
  event: string;
  receivedAt: string;
}

export interface WebhookDeliveryAcceptanceDependencies {
  now(): Date;
}

export type WebhookDeliveryAcceptanceResult =
  | {
      body: WebhookAcceptedBody;
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
  const logContext = {
    deliveryId,
    event,
    receivedAt,
  };

  if (!signatureValid) {
    return rejectRecordedWebhookDelivery(env, logContext, {
      installationId: null,
      signatureValid: false,
      status: 401,
    });
  }

  let payload: InstallationWebhookPayload;

  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as InstallationWebhookPayload;
  } catch {
    return rejectRecordedWebhookDelivery(env, logContext, {
      installationId: null,
      signatureValid: true,
      status: 400,
    });
  }

  if (event === "ping") {
    return acceptRecordedWebhookDelivery(env, logContext, {
      body: { accepted: true, event },
      installationId: null,
    });
  }

  const installationId = payload.installation?.id;

  if (!Number.isInteger(installationId) || installationId === undefined || installationId <= 0) {
    return rejectRecordedWebhookDelivery(env, logContext, {
      installationId: null,
      signatureValid: true,
      status: 400,
    });
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(installationId));
  const result = (await stub.signalInstallationReconciliation({
    installationId,
    signalSource: "webhook",
  })) as SignalInstallationReconciliationResult;

  if (!result.ok) {
    return rejectRecordedWebhookDelivery(env, logContext, {
      installationId,
      signatureValid: true,
      status: result.status,
    });
  }

  return acceptRecordedWebhookDelivery(env, logContext, {
    body: { accepted: true },
    installationId,
    metadata: { signal_source: "webhook" },
  });
}

async function acceptRecordedWebhookDelivery(
  env: Env,
  context: WebhookDeliveryLogContext,
  input: AcceptedWebhookDeliveryLogInput,
): Promise<WebhookDeliveryAcceptanceResult> {
  await recordWebhookDelivery(env, {
    accepted: true,
    deliveryId: context.deliveryId,
    event: context.event,
    installationId: input.installationId,
    metadata: input.metadata,
    receivedAt: context.receivedAt,
    responseStatusCode: 202,
    signatureValid: true,
  });

  return accepted(input.body);
}

async function rejectRecordedWebhookDelivery(
  env: Env,
  context: WebhookDeliveryLogContext,
  input: RejectedWebhookDeliveryLogInput,
): Promise<WebhookDeliveryAcceptanceResult> {
  await recordWebhookDelivery(env, {
    accepted: false,
    deliveryId: context.deliveryId,
    event: context.event,
    installationId: input.installationId,
    receivedAt: context.receivedAt,
    responseStatusCode: input.status,
    signatureValid: input.signatureValid,
  });

  return rejected(input.status);
}

function accepted(body: WebhookAcceptedBody): WebhookDeliveryAcceptanceResult {
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
