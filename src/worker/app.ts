import type { Env } from "../env.ts";
import { GitHubApiError, resolveInstallationForRepository } from "../github/api.ts";
import type { AuthenticatedContext } from "../oidc/principals.ts";
import type {
  MintInstallationTokenResult,
  RunMigrationsResult,
  ReceiveWebhookResult,
} from "../durable-objects/installation-object.ts";
import {
  authenticateOidcToken,
  authenticateRequest,
  githubActionsPrincipal,
} from "./authentication.ts";
import { jsonResponse, problemResponse } from "./problem-details.ts";

const textEncoder = new TextEncoder();
const maxWebhookBodyBytes = 256 * 1024;
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const githubInstallationAccessTokenType = "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";
const oauthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token";

export const app: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/token") {
      if (request.method !== "POST") {
        return oauthErrorResponse(400, "invalid_request");
      }

      return handleTokenExchangeRequest(request, env);
    }

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

    if (url.pathname === "/internal/durable-objects/github-installations/migrate") {
      if (request.method !== "POST") {
        return problemResponse(405, { allow: "POST" });
      }

      return handleInstallationMigrationRequest(request, env);
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

  const result = await mintInstallationTokenForContext(env, authentication.context);

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

async function handleTokenExchangeRequest(request: Request, env: Env): Promise<Response> {
  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  const grantType = singleFormValue(form, "grant_type");
  const requestedTokenType = singleFormValue(form, "requested_token_type");
  const subjectToken = singleFormValue(form, "subject_token");
  const subjectTokenType = singleFormValue(form, "subject_token_type");

  if (grantType !== tokenExchangeGrantType) {
    return oauthErrorResponse(400, "unsupported_grant_type");
  }

  if (subjectToken === null || subjectToken.length === 0 || subjectTokenType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (subjectTokenType !== oidcIdTokenType && subjectTokenType !== jwtTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (
    requestedTokenType !== null &&
    requestedTokenType !== githubInstallationAccessTokenType &&
    requestedTokenType !== oauthAccessTokenType
  ) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const authentication = await authenticateOidcToken(subjectToken, request, env);

  if (!authentication.ok) {
    return oauthErrorResponse(
      authentication.httpStatus === 500 ? 500 : 400,
      authentication.httpStatus === 500 ? "server_error" : "invalid_request",
    );
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const result = await mintInstallationTokenForContext(env, authentication.context);

  if (!result.ok) {
    return oauthErrorResponse(
      oauthStatusForMintFailure(result.status),
      oauthErrorCodeForMintFailure(result.status),
    );
  }

  return oauthTokenResponse({
    access_token: result.token,
    expires_in: expiresInSeconds(result.expiresAt),
    issued_token_type: githubInstallationAccessTokenType,
    token_type: "Bearer",
  });
}

async function mintInstallationTokenForContext(
  env: Env,
  authenticationContext: AuthenticatedContext,
): Promise<MintInstallationTokenResult> {
  const { issuerRegistration, principal, resolvedKeyId } = authenticationContext;
  let installation;

  try {
    installation = await resolveInstallationForRepository(env, principal.repository);
  } catch (error) {
    console.error("GitHub installation lookup failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      eventName: principal.eventName,
      ref: principal.ref,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    return {
      ok: false,
      status: statusForGitHubApiError(error),
    };
  }

  const stub = env.GITHUB_INSTALLATION.getByName(String(installation.id));
  return (await stub.mintInstallationToken({
    installationId: installation.id,
    issuer: issuerRegistration.issuer,
    principal,
    resolvedKeyId,
  })) as MintInstallationTokenResult;
}

function responseForGitHubApiError(error: unknown): Response {
  return problemResponse(statusForGitHubApiError(error));
}

function statusForGitHubApiError(error: unknown): number {
  if (error instanceof Response) {
    return error.status;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 400) {
      return 500;
    }

    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return 403;
    }

    if (error.status >= 500) {
      return 502;
    }
  }

  return 500;
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

  if (event === "ping") {
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

async function handleInstallationMigrationRequest(request: Request, env: Env): Promise<Response> {
  const configuredToken = env.MAINTENANCE_API_TOKEN;

  if (configuredToken === undefined || configuredToken.length === 0) {
    return problemResponse(404);
  }

  const presentedToken = extractBearerToken(request.headers.get("authorization"));

  if (presentedToken !== configuredToken) {
    return problemResponse(401, { "www-authenticate": "Bearer" });
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return problemResponse(415);
  }

  let payload: { object_ids?: unknown };

  try {
    payload = (await request.json()) as { object_ids?: unknown };
  } catch {
    return problemResponse(400);
  }

  const objectIds = parseMigrationObjectIds(payload.object_ids);

  if (objectIds === null) {
    return problemResponse(400);
  }

  try {
    const migratedObjectIds: string[] = [];

    for (const objectId of objectIds) {
      const durableObjectId = env.GITHUB_INSTALLATION.idFromString(objectId);
      const stub = env.GITHUB_INSTALLATION.get(durableObjectId);
      const result = (await stub.runMigrations()) as RunMigrationsResult;

      if (!result.ok) {
        return problemResponse(500);
      }

      migratedObjectIds.push(objectId);
    }

    return jsonResponse(
      {
        migrated: true,
        object_ids: migratedObjectIds,
      },
      { status: 200 },
    );
  } catch {
    return problemResponse(400);
  }
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

function isFormUrlEncodedContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
    return null;
  }

  return token;
}

function parseMigrationObjectIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const objectIds = [...new Set(value)];

  if (
    !objectIds.every((objectId) => typeof objectId === "string" && /^[0-9a-f]{64}$/u.test(objectId))
  ) {
    return null;
  }

  return objectIds;
}

function singleFormValue(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);

  if (values.length !== 1) {
    return null;
  }

  return values[0] ?? null;
}

function oauthTokenResponse(body: Record<string, number | string>): Response {
  return jsonResponse(body, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
    status: 200,
  });
}

function oauthErrorResponse(status: number, error: string): Response {
  return jsonResponse(
    { error },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      status,
    },
  );
}

function oauthErrorCodeForMintFailure(status: number): string {
  if (status === 403) {
    return "invalid_target";
  }

  return "server_error";
}

function oauthStatusForMintFailure(status: number): number {
  if (status === 403) {
    return 400;
  }

  if (status === 502) {
    return 502;
  }

  return 500;
}

function expiresInSeconds(expiresAt: string): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
}
