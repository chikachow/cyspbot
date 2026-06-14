import { resolveSecretText, type SecretTextBinding } from "@cyspbot/github/secrets";
import { readRequestBodyUpTo } from "@cyspbot/http/request-body";
import { verifyGitHubWebhookSignature } from "./signature.ts";

const maxWebhookBodyBytes = 256 * 1024;

type WebhookAcceptedBody = { accepted: true; event?: string };

interface AuthenticatedWebhookEnvelope {
  body: string;
  deliveryId: string;
  event: string;
  kind: "authenticated";
}

export interface GitHubWebhookReceiverBaseEnv {
  GITHUB_APP_ID: string;
  GITHUB_WEBHOOK_SECRET?: SecretTextBinding;
}

export interface GitHubWebhookReceiverDependencies {
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

type WebhookDeliveryRejection = Extract<WebhookDeliveryAcceptanceResult, { kind: "rejected" }>;

export async function acceptGitHubWebhookDelivery<Env extends GitHubWebhookReceiverBaseEnv>(
  request: Request,
  env: Env,
  dependencies: GitHubWebhookReceiverDependencies,
): Promise<WebhookDeliveryAcceptanceResult> {
  const secret = await resolveSecretText(env.GITHUB_WEBHOOK_SECRET);
  const receivedAt = dependencies.now().toISOString();

  if (secret === undefined || secret.length === 0) {
    console.error("webhook_receiver_not_configured", { occurred_at: receivedAt });
    return rejected(500);
  }

  const envelope = await authenticateWebhookEnvelope({
    env,
    request,
    secret,
  });

  if (envelope.kind !== "authenticated") {
    logWebhookRejection(envelope.status, request);
    return envelope;
  }

  try {
    void JSON.parse(envelope.body);
  } catch {
    logWebhookRejection(400, request, envelope);
    return rejected(400);
  }

  if (envelope.event === "ping") {
    return accepted({ accepted: true, event: envelope.event });
  }

  return accepted({ accepted: true });
}

async function authenticateWebhookEnvelope<Env extends GitHubWebhookReceiverBaseEnv>(input: {
  env: Env;
  request: Request;
  secret: string;
}): Promise<AuthenticatedWebhookEnvelope | WebhookDeliveryAcceptanceResult> {
  const { env, request, secret } = input;

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return rejected(415);
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const targetId = request.headers.get("x-github-hook-installation-target-id");
  const targetType = request.headers.get("x-github-hook-installation-target-type");
  const body = await readRequestBodyUpTo(request, maxWebhookBodyBytes);

  if (!body.ok) {
    return rejected(body.status);
  }

  if (event === null || deliveryId === null || signatureHeader === null) {
    return rejected(400);
  }

  if (targetType !== "integration" || targetId !== env.GITHUB_APP_ID) {
    return rejected(401);
  }

  if (
    !(await verifyGitHubWebhookSignature({
      body: body.bytes,
      secret,
      signatureHeader,
    }))
  ) {
    return rejected(401);
  }

  return {
    body: new TextDecoder().decode(body.bytes),
    deliveryId,
    event,
    kind: "authenticated",
  };
}

function logWebhookRejection(
  status: number,
  request: Request,
  envelope?: AuthenticatedWebhookEnvelope,
): void {
  console.warn("github_webhook_rejected", {
    deliveryId: envelope?.deliveryId ?? request.headers.get("x-github-delivery"),
    event: envelope?.event ?? request.headers.get("x-github-event"),
    rayId: request.headers.get("cf-ray"),
    status,
  });
}

function accepted(
  body: WebhookAcceptedBody,
): Extract<WebhookDeliveryAcceptanceResult, { kind: "accepted" }> {
  return {
    body,
    kind: "accepted",
    status: 202,
  };
}

function rejected(status: number): WebhookDeliveryRejection {
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
