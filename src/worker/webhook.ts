import type { Env } from "../env.ts";
import type { SignalInstallationReconciliationResult } from "../durable-objects/installation-object.ts";
import { recordWebhookDelivery } from "../storage/webhook-delivery-log.ts";
import type { AppDependencies } from "./dependencies.ts";
import { jsonResponse, problemResponse } from "./problem-details.ts";

const textEncoder = new TextEncoder();
const maxWebhookBodyBytes = 256 * 1024;

interface InstallationWebhookPayload {
  installation?: {
    id?: number;
  };
}

export async function handleGitHubWebhookRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  const receivedAt = dependencies.now().toISOString();

  if (secret === undefined || secret.length === 0) {
    console.error("webhook_receiver_not_configured", { occurred_at: receivedAt });
    return problemResponse(500);
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return problemResponse(415);
  }

  const contentLength = request.headers.get("content-length");

  if (contentLength !== null) {
    const parsedContentLength = Number.parseInt(contentLength, 10);

    if (!Number.isSafeInteger(parsedContentLength) || parsedContentLength < 0) {
      return problemResponse(400);
    }

    if (parsedContentLength > maxWebhookBodyBytes) {
      return problemResponse(413);
    }
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  if (bodyBytes.byteLength > maxWebhookBodyBytes) {
    return problemResponse(413);
  }

  if (event === null || deliveryId === null || signatureHeader === null) {
    return problemResponse(400);
  }

  const valid = await verifyGitHubWebhookSignature(bodyBytes, signatureHeader, secret);

  if (!valid) {
    await recordWebhookDelivery(env, {
      accepted: false,
      deliveryId,
      event,
      installationId: null,
      receivedAt,
      responseStatusCode: 401,
      signatureValid: false,
    });

    return problemResponse(401);
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

    return problemResponse(400);
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

    return jsonResponse(
      {
        accepted: true,
        event,
      },
      { status: 202 },
    );
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

    return problemResponse(400);
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

    return problemResponse(result.status);
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

  return jsonResponse(
    {
      accepted: true,
    },
    { status: 202 },
  );
}

async function verifyGitHubWebhookSignature(
  body: Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = signatureHeader.slice("sha256=".length);

  if (!/^[a-f0-9]{64}$/u.test(expectedHex)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytesAsBufferSource(body)));
  const actualHex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");

  return constantTimeEquals(actualHex, expectedHex);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function bytesAsBufferSource(value: Uint8Array): BufferSource {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);

  return copy;
}
