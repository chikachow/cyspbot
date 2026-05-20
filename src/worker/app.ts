import type { Env } from "../env.ts";
import { GitHubApiError, resolveInstallationForRepository } from "../github/api.ts";
import type {
  MintInstallationTokenResult,
  ReceiveWebhookResult,
} from "../durable-objects/installation-object.ts";
import { githubActionsPrincipal, authenticateRequest } from "./authentication.ts";
import { jsonResponse, problemResponse } from "./problem-details.ts";

const textEncoder = new TextEncoder();
const maxWebhookBodyBytes = 256 * 1024;

export const app: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/github/claims") {
      if (request.method !== "POST") {
        return problemResponse(405, { allow: "POST" });
      }

      return handleClaimsRequest(request, env);
    }

    if (url.pathname === "/github/installations/token") {
      if (request.method !== "POST") {
        return problemResponse(405, { allow: "POST" });
      }

      return handleInstallationTokenRequest(request, env);
    }

    if (url.pathname === "/github/webhooks") {
      if (request.method !== "POST") {
        return problemResponse(405, { allow: "POST" });
      }

      return handleGitHubWebhookRequest(request, env);
    }

    return problemResponse(404);
  },
};

async function handleClaimsRequest(request: Request, env: Env): Promise<Response> {
  const authentication = await authenticateRequest(request, env);

  if (!authentication.ok) {
    return problemResponse(authentication.httpStatus, authentication.responseHeaders);
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return problemResponse(403);
  }

  try {
    await resolveInstallationForRepository(env, authentication.context.principal.repository);
  } catch (error) {
    return responseForGitHubApiError(error);
  }

  return jsonResponse({
    event_name: authentication.context.principal.eventName,
    ref: authentication.context.principal.ref,
    repository: authentication.context.principal.repository,
    repository_id: authentication.context.principal.repositoryId,
  });
}

async function handleInstallationTokenRequest(request: Request, env: Env): Promise<Response> {
  const authentication = await authenticateRequest(request, env);

  if (!authentication.ok) {
    return problemResponse(authentication.httpStatus, authentication.responseHeaders);
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return problemResponse(403);
  }

  let installation;

  try {
    installation = await resolveInstallationForRepository(
      env,
      authentication.context.principal.repository,
    );
  } catch (error) {
    console.error("GitHub installation lookup failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      eventName: authentication.context.principal.eventName,
      ref: authentication.context.principal.ref,
      repository: authentication.context.principal.repository,
      repositoryId: authentication.context.principal.repositoryId,
    });
    return responseForGitHubApiError(error);
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(installation.id));
  const result = (await stub.mintInstallationToken({
    installationId: installation.id,
    principal: authentication.context.principal,
  })) as MintInstallationTokenResult;

  if (!result.ok) {
    return problemResponse(result.status);
  }

  return jsonResponse(
    {
      expires_at: result.expiresAt,
      token: result.token,
    },
    { status: 200 },
  );
}

function responseForGitHubApiError(error: unknown): Response {
  if (error instanceof Response) {
    return error;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 400) {
      return problemResponse(500);
    }

    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return problemResponse(403);
    }

    if (error.status >= 500) {
      return problemResponse(502);
    }
  }

  return problemResponse(500);
}

interface InstallationWebhookPayload {
  installation?: {
    id?: number;
  };
}

async function handleGitHubWebhookRequest(request: Request, env: Env): Promise<Response> {
  const secret = env.GITHUB_WEBHOOK_SECRET;

  if (secret === undefined || secret.length === 0) {
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
    return problemResponse(401);
  }

  let payload: InstallationWebhookPayload;

  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as InstallationWebhookPayload;
  } catch {
    return problemResponse(400);
  }

  const installationId = payload.installation?.id;

  if (!Number.isInteger(installationId) || installationId === undefined || installationId <= 0) {
    return problemResponse(400);
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(installationId));

  const result = (await stub.receiveWebhook({
    body: new TextDecoder().decode(bodyBytes),
    deliveryId,
    event,
    installationId,
    signature: signatureHeader,
  })) as ReceiveWebhookResult;

  if (!result.ok) {
    return problemResponse(result.status);
  }

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
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as BufferSource));
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
