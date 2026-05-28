import type { SignalInstallationReconciliationResult } from "../durable-objects/installation-object.ts";
import type { Env } from "../env.ts";
import { pullRequestHaikuFeatureEnabled } from "../pull-request-haiku/feature-flag.ts";
import type { PullRequestHaikuQueueMessage } from "../pull-request-haiku/queue.ts";
import {
  pullRequestHaikuRepositoryOptedIn,
  recordPullRequestHaikuQueued,
} from "../storage/pull-request-haiku.ts";
import { verifyGitHubWebhookSignature } from "./signature.ts";

const maxWebhookBodyBytes = 256 * 1024;

interface InstallationWebhookPayload {
  action?: unknown;
  installation?: {
    id?: number;
  };
  pull_request?: {
    head?: {
      sha?: unknown;
    };
    number?: unknown;
  };
  repository?: {
    full_name?: unknown;
    id?: unknown;
  };
}

type WebhookAcceptedBody = { accepted: true; event?: string };

interface AuthenticatedWebhookEnvelope {
  bodyBytes: Uint8Array;
  deliveryId: string;
  event: string;
  kind: "authenticated";
  receivedAt: string;
}

type ParsedWebhookDelivery =
  | {
      kind: "installation";
      installationId: number;
      payload: InstallationWebhookPayload;
    }
  | {
      kind: "ping";
    };

export interface WebhookDeliveryAcceptanceDependencies {
  enqueuePullRequestHaikuMessage(env: Env, message: PullRequestHaikuQueueMessage): Promise<void>;
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

  const envelope = await authenticateWebhookEnvelope(request, env, secret, receivedAt);

  if (envelope.kind !== "authenticated") {
    return envelope;
  }

  const parsedDelivery = parseWebhookDelivery(envelope);

  if (parsedDelivery.kind === "rejected") {
    return parsedDelivery;
  }

  if (parsedDelivery.kind === "ping") {
    return accepted({ accepted: true, event: envelope.event });
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(parsedDelivery.installationId));
  const result = (await stub.signalInstallationReconciliation({
    installationId: parsedDelivery.installationId,
    signalSource: "webhook",
  })) as SignalInstallationReconciliationResult;

  if (!result.ok) {
    return rejected(result.status);
  }

  await enqueuePullRequestHaikuIfNeeded({
    deliveryId: envelope.deliveryId,
    dependencies,
    env,
    event: envelope.event,
    installationId: parsedDelivery.installationId,
    payload: parsedDelivery.payload,
    receivedAt: envelope.receivedAt,
  });

  return accepted({ accepted: true });
}

async function authenticateWebhookEnvelope(
  request: Request,
  env: Env,
  secret: string,
  receivedAt: string,
): Promise<AuthenticatedWebhookEnvelope | WebhookDeliveryAcceptanceResult> {
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
  const targetId = request.headers.get("x-github-hook-installation-target-id");
  const targetType = request.headers.get("x-github-hook-installation-target-type");
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  if (bodyBytes.byteLength > maxWebhookBodyBytes) {
    return rejected(413);
  }

  if (event === null || deliveryId === null || signatureHeader === null) {
    return rejected(400);
  }

  if (targetType !== "integration" || targetId !== env.GITHUB_APP_ID) {
    return rejected(401);
  }

  if (!(await verifyGitHubWebhookSignature(bodyBytes, signatureHeader, secret))) {
    return rejected(401);
  }

  return {
    bodyBytes,
    deliveryId,
    event,
    kind: "authenticated",
    receivedAt,
  };
}

function parseWebhookDelivery(
  envelope: AuthenticatedWebhookEnvelope,
): ParsedWebhookDelivery | WebhookDeliveryRejection {
  let payload: InstallationWebhookPayload;

  try {
    payload = JSON.parse(
      new TextDecoder().decode(envelope.bodyBytes),
    ) as InstallationWebhookPayload;
  } catch {
    return rejected(400);
  }

  if (envelope.event === "ping") {
    return { kind: "ping" };
  }

  const installationId = payload.installation?.id;

  if (!Number.isInteger(installationId) || installationId === undefined || installationId <= 0) {
    return rejected(400);
  }

  return {
    installationId,
    kind: "installation",
    payload,
  };
}

async function enqueuePullRequestHaikuIfNeeded(input: {
  deliveryId: string;
  dependencies: WebhookDeliveryAcceptanceDependencies;
  env: Env;
  event: string;
  installationId: number;
  payload: InstallationWebhookPayload;
  receivedAt: string;
}): Promise<string | null> {
  if (input.event !== "pull_request") {
    return null;
  }

  const action = typeof input.payload.action === "string" ? input.payload.action : "";

  if (!pullRequestHaikuActionSupported(action)) {
    return "ignored_action";
  }

  const repositoryId = input.payload.repository?.id;
  const repositoryFullName = input.payload.repository?.full_name;
  const pullRequestNumber = input.payload.pull_request?.number;
  const headSha = input.payload.pull_request?.head?.sha;

  if (
    typeof repositoryId !== "number" ||
    !Number.isSafeInteger(repositoryId) ||
    repositoryId <= 0 ||
    typeof repositoryFullName !== "string" ||
    repositoryFullName.length === 0 ||
    typeof pullRequestNumber !== "number" ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    typeof headSha !== "string" ||
    headSha.length === 0
  ) {
    return "invalid_payload";
  }

  if (
    !(await pullRequestHaikuFeatureEnabled(input.env, {
      installationId: input.installationId,
      pullRequestNumber,
      repositoryFullName,
      repositoryId,
    }))
  ) {
    return "feature_disabled";
  }

  if (!(await pullRequestHaikuRepositoryOptedIn(input.env, repositoryId))) {
    return "repository_not_opted_in";
  }

  const message = {
    action,
    deliveryId: input.deliveryId,
    enqueuedAt: input.receivedAt,
    headSha,
    installationId: input.installationId,
    pullRequestNumber,
    repositoryFullName,
    repositoryId,
  } satisfies PullRequestHaikuQueueMessage;

  await recordPullRequestHaikuQueued(input.env, {
    action,
    deliveryId: input.deliveryId,
    headSha,
    installationId: input.installationId,
    pullRequestNumber,
    queuedAt: input.receivedAt,
    repositoryFullName,
    repositoryId,
  });
  await input.dependencies.enqueuePullRequestHaikuMessage(input.env, message);

  return "queued";
}

function pullRequestHaikuActionSupported(action: string): boolean {
  return (
    action === "opened" ||
    action === "reopened" ||
    action === "synchronize" ||
    action === "edited" ||
    action === "ready_for_review"
  );
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
