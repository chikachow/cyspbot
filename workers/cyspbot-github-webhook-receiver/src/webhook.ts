import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";
import { jsonResponse, problemResponse } from "@cyspbot/http/problem-details";
import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { readRequestBodyUpTo } from "@cyspbot/http/request-body";
import { verifyGitHubWebhookSignature } from "./github-webhooks/signature.ts";
import { classifyStatusReactionJob } from "./github-webhooks/status-reaction.ts";

const maxWebhookBodyBytes = 256 * 1024;

interface AuthenticatedWebhookEnvelope {
  body: Uint8Array;
  deliveryId: string;
  event: string;
}

interface GitHubWebhookJobQueue {
  send(
    message: GitHubIssueCommentStatusReactionJob,
    options?: { contentType?: "json" },
  ): Promise<unknown>;
}

interface WebhookReceiverEnvironment {
  GITHUB_APP_ID: string;
  GITHUB_WEBHOOK_JOBS: GitHubWebhookJobQueue;
  GITHUB_WEBHOOK_SECRET?: SecretTextBinding;
}

export async function handleGitHubWebhookRequest(
  request: Request,
  env: WebhookReceiverEnvironment,
): Promise<Response> {
  let secret: string | undefined;
  try {
    secret = await resolveSecretText(env.GITHUB_WEBHOOK_SECRET);
  } catch {
    console.error("webhook_receiver_secret_unavailable");
    return problemResponse(500);
  }

  if (secret === undefined || secret.length === 0) {
    console.error("webhook_receiver_not_configured");
    return problemResponse(500);
  }

  const envelope = await authenticateWebhookEnvelope({
    env,
    request,
    secret,
  });

  if (envelope instanceof Response) {
    logWebhookRejection(envelope.status, request);
    return envelope;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(envelope.body),
    );
  } catch {
    logWebhookRejection(400, request, envelope);
    return problemResponse(400);
  }

  if (envelope.event === "ping") {
    return jsonResponse({ accepted: true, event: envelope.event }, { status: 202 });
  }

  const job = classifyStatusReactionJob(envelope.event, envelope.deliveryId, payload);
  if (job !== undefined) {
    try {
      await env.GITHUB_WEBHOOK_JOBS.send(job, { contentType: "json" });
    } catch (error) {
      console.error("github_webhook_job_enqueue_failed", {
        deliveryId: envelope.deliveryId,
        error: error instanceof Error ? error.name : typeof error,
        event: envelope.event,
      });
      return problemResponse(503);
    }
  }

  return jsonResponse({ accepted: true }, { status: 202 });
}

async function authenticateWebhookEnvelope(input: {
  env: WebhookReceiverEnvironment;
  request: Request;
  secret: string;
}): Promise<AuthenticatedWebhookEnvelope | Response> {
  const { env, request, secret } = input;

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return problemResponse(415);
  }

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  const signatureHeader = request.headers.get("x-hub-signature-256");
  const targetId = request.headers.get("x-github-hook-installation-target-id");
  const targetType = request.headers.get("x-github-hook-installation-target-type");
  const body = await readRequestBodyUpTo(request, maxWebhookBodyBytes);

  if (!body.ok) {
    return problemResponse(body.status);
  }

  if (event === null || deliveryId === null || signatureHeader === null) {
    return problemResponse(400);
  }

  if (targetType !== "integration" || targetId !== env.GITHUB_APP_ID) {
    return problemResponse(401);
  }

  if (
    !(await verifyGitHubWebhookSignature({
      body: body.bytes,
      secret,
      signatureHeader,
    }))
  ) {
    return problemResponse(401);
  }

  return {
    body: body.bytes,
    deliveryId,
    event,
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

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
