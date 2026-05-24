import type { Env } from "../env.ts";
import {
  clearDashboardSessionCookie,
  clearDashboardStateCookie,
  createEncryptedValue,
  createSignedDashboardOauthStateCookie,
  createSignedDashboardSessionCookie,
  decryptValue,
  randomToken,
  readDashboardOauthState,
  readDashboardSessionId,
} from "../dashboard/auth.ts";
import {
  renderDashboardRepositoryDetailsPage,
  renderDashboardRepositoryListPage,
} from "../dashboard/html.ts";
import type {
  DashboardSessionObject,
  DashboardRepositoryAccessEntry,
  DashboardSessionState,
  StoredDashboardSession,
} from "../dashboard/session-object.ts";
import {
  exchangeGitHubUserCode,
  getAuthenticatedGitHubUser,
  GitHubApiError,
  listGitHubUserInstallationRepositories,
  listGitHubUserInstallations,
  refreshGitHubUserAccessToken,
  resolveInstallationForRepository,
} from "../github/api.ts";
import type { AuthenticatedContext } from "../oidc/principals.ts";
import type {
  RepositoryTokenRequestEntry,
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
const dashboardAccessCacheDefaultTtlSeconds = 300;

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

    if (url.pathname === "/dashboard/login/github") {
      if (request.method !== "GET") {
        return problemResponse(405, { allow: "GET" });
      }

      return handleDashboardLoginRequest(request, env);
    }

    if (url.pathname === "/dashboard/auth/github/callback") {
      if (request.method !== "GET") {
        return problemResponse(405, { allow: "GET" });
      }

      return handleDashboardCallbackRequest(request, env);
    }

    if (url.pathname === "/dashboard/logout") {
      if (request.method !== "GET") {
        return problemResponse(405, { allow: "GET" });
      }

      return handleDashboardLogoutRequest(request, env);
    }

    if (url.pathname === "/dashboard") {
      if (request.method !== "GET") {
        return problemResponse(405, { allow: "GET" });
      }

      return handleDashboardRepositoryListRequest(request, env);
    }

    if (url.pathname.startsWith("/dashboard/repositories/")) {
      if (request.method !== "GET") {
        return problemResponse(405, { allow: "GET" });
      }

      return handleDashboardRepositoryDetailsRequest(request, env, url.pathname);
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

async function handleDashboardLoginRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = sanitizeDashboardReturnTo(url.searchParams.get("return_to"));
  const oauthState = await createSignedDashboardOauthStateCookie(env, returnTo);
  const authorizeUrl = new URL(
    "/login/oauth/authorize",
    env.GITHUB_WEB_BASE_URL ?? "https://github.com",
  );

  authorizeUrl.searchParams.set("client_id", requireDashboardClientId(env));
  authorizeUrl.searchParams.set("redirect_uri", dashboardCallbackUrl(request));
  authorizeUrl.searchParams.set("state", oauthState.state);

  return new Response(null, {
    headers: {
      location: authorizeUrl.toString(),
      "set-cookie": oauthState.cookie,
    },
    status: 302,
  });
}

async function handleDashboardCallbackRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = await readDashboardOauthState(request, env);

  if (
    code === null ||
    state === null ||
    storedState === null ||
    storedState.state !== state ||
    !dashboardOauthStateFresh(storedState.issuedAt)
  ) {
    return dashboardProblemResponse(400, {
      "set-cookie": clearDashboardStateCookie(),
    });
  }

  try {
    const token = await exchangeGitHubUserCode(env, code, dashboardCallbackUrl(request));
    const user = await getAuthenticatedGitHubUser(env, token.accessToken);
    const sessionId = randomToken();
    const sessionStub = env.DASHBOARD_SESSION.getByName(sessionId);
    const session = await createDashboardSessionState(env, user, token);

    await sessionStub.storeSession(session);
    await refreshDashboardRepositoryAccess(env, sessionStub, token.accessToken);

    const headers = new Headers({
      location: storedState.returnTo,
    });
    headers.append("set-cookie", clearDashboardStateCookie());
    headers.append("set-cookie", await createSignedDashboardSessionCookie(env, sessionId));

    return new Response(null, {
      headers,
      status: 302,
    });
  } catch (error) {
    console.error("Dashboard GitHub callback failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
    });

    return dashboardProblemResponse(502, {
      "set-cookie": clearDashboardStateCookie(),
    });
  }
}

async function handleDashboardLogoutRequest(request: Request, env: Env): Promise<Response> {
  const sessionId = await readDashboardSessionId(request, env);

  if (sessionId !== null) {
    const sessionStub = env.DASHBOARD_SESSION.getByName(sessionId);
    await sessionStub.clearSession();
  }

  return new Response(null, {
    headers: {
      location: "/dashboard",
      "set-cookie": clearDashboardSessionCookie(),
    },
    status: 302,
  });
}

async function handleDashboardRepositoryListRequest(request: Request, env: Env): Promise<Response> {
  const dashboardSession = await requireDashboardSession(request, env);

  if (!dashboardSession.ok) {
    return dashboardSession.response;
  }

  const repositories = [...dashboardSession.repositories].sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );

  return htmlResponse(
    renderDashboardRepositoryListPage({
      githubLogin: dashboardSession.session.githubLogin,
      repositories,
    }),
  );
}

async function handleDashboardRepositoryDetailsRequest(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  const dashboardSession = await requireDashboardSession(request, env);

  if (!dashboardSession.ok) {
    return dashboardSession.response;
  }

  const repositoryId = pathname.slice("/dashboard/repositories/".length);
  const repository = dashboardSession.repositories.find(
    (entry) => entry.githubRepoId === repositoryId,
  );

  if (repository === undefined) {
    return dashboardProblemResponse(403);
  }

  const installationStub = env.GITHUB_INSTALLATION.getByName(String(repository.installationId));
  const tokenRequests = (await installationStub.listRepositoryTokenRequests({
    limit: 5,
    repositoryId: repository.githubRepoId,
  })) as RepositoryTokenRequestEntry[];

  return htmlResponse(
    renderDashboardRepositoryDetailsPage({
      githubLogin: dashboardSession.session.githubLogin,
      repository,
      tokenRequests,
    }),
  );
}

async function requireDashboardSession(
  request: Request,
  env: Env,
): Promise<
  | {
      ok: true;
      repositories: DashboardRepositoryAccessEntry[];
      session: DashboardSessionState;
    }
  | { ok: false; response: Response }
> {
  const sessionId = await readDashboardSessionId(request, env);

  if (sessionId === null) {
    return {
      ok: false,
      response: dashboardLoginRedirectResponse(request),
    };
  }

  const sessionStub = env.DASHBOARD_SESSION.getByName(sessionId);
  const stored = (await sessionStub.getSession()) as StoredDashboardSession;

  if (stored.session === null) {
    return {
      ok: false,
      response: dashboardLoginRedirectResponse(request),
    };
  }

  const tokenResult = await ensureDashboardAccessToken(env, sessionStub, stored.session);

  if (!tokenResult.ok) {
    return {
      ok: false,
      response: tokenResult.response,
    };
  }

  let repositories = stored.repositories;
  let session = tokenResult.session;

  if (
    session.repositoryAccessCacheExpiresAt === null ||
    isExpired(session.repositoryAccessCacheExpiresAt)
  ) {
    try {
      repositories = await refreshDashboardRepositoryAccess(
        env,
        sessionStub,
        tokenResult.accessToken,
      );
      const refreshed = (await sessionStub.getSession()) as StoredDashboardSession;

      if (refreshed.session !== null) {
        session = refreshed.session;
      }
    } catch (error) {
      console.error("Dashboard repository access refresh failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
      });

      if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
        await sessionStub.clearSession();

        return {
          ok: false,
          response: dashboardLoginRedirectResponse(request, clearDashboardSessionCookie()),
        };
      }

      return {
        ok: false,
        response: dashboardProblemResponse(502),
      };
    }
  }

  return {
    ok: true,
    repositories,
    session,
  };
}

async function ensureDashboardAccessToken(
  env: Env,
  sessionStub: DurableObjectStub<DashboardSessionObject>,
  session: DashboardSessionState,
): Promise<
  | { accessToken: string; ok: true; session: DashboardSessionState }
  | { ok: false; response: Response }
> {
  if (session.accessTokenExpiresAt === null || !isExpiredSoon(session.accessTokenExpiresAt)) {
    const accessToken = await decryptValue(env, session.accessTokenCiphertext);

    if (accessToken !== null) {
      return {
        accessToken,
        ok: true,
        session,
      };
    }
  }

  if (session.refreshTokenCiphertext === null) {
    await sessionStub.clearSession();

    return {
      ok: false,
      response: dashboardLoginRedirectResponse(undefined, clearDashboardSessionCookie()),
    };
  }

  const refreshToken = await decryptValue(env, session.refreshTokenCiphertext);

  if (refreshToken === null) {
    await sessionStub.clearSession();

    return {
      ok: false,
      response: dashboardLoginRedirectResponse(undefined, clearDashboardSessionCookie()),
    };
  }

  try {
    const refreshedToken = await refreshGitHubUserAccessToken(env, refreshToken);
    const updatedSession = await createDashboardSessionState(
      env,
      {
        id: session.githubUserId,
        login: session.githubLogin,
      },
      refreshedToken,
    );

    await sessionStub.storeSession(updatedSession);

    return {
      accessToken: refreshedToken.accessToken,
      ok: true,
      session: updatedSession,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 400 || error.status === 401)) {
      await sessionStub.clearSession();

      return {
        ok: false,
        response: dashboardLoginRedirectResponse(undefined, clearDashboardSessionCookie()),
      };
    }

    throw error;
  }
}

async function refreshDashboardRepositoryAccess(
  env: Env,
  sessionStub: DurableObjectStub<DashboardSessionObject>,
  accessToken: string,
): Promise<DashboardRepositoryAccessEntry[]> {
  const repositoriesById = new Map<string, DashboardRepositoryAccessEntry>();
  const installations = await listGitHubUserInstallations(env, accessToken);

  for (const installation of installations) {
    const repositories = await listGitHubUserInstallationRepositories(
      env,
      accessToken,
      installation.id,
    );

    for (const repository of repositories) {
      if (!repositoriesById.has(repository.githubRepoId)) {
        repositoriesById.set(repository.githubRepoId, repository);
      }
    }
  }

  const repositories = [...repositoriesById.values()];
  await sessionStub.replaceRepositoryAccessCache({
    expiresAt: new Date(Date.now() + dashboardAccessCacheTtlMs(env)).toISOString(),
    repositories,
  });

  return repositories;
}

async function createDashboardSessionState(
  env: Env,
  user: { id: string; login: string },
  token: {
    accessToken: string;
    accessTokenExpiresAt: string | null;
    refreshToken: string | null;
    refreshTokenExpiresAt: string | null;
  },
): Promise<DashboardSessionState> {
  return {
    accessTokenCiphertext: await createEncryptedValue(env, token.accessToken),
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    githubLogin: user.login,
    githubUserId: user.id,
    refreshTokenCiphertext:
      token.refreshToken === null ? null : await createEncryptedValue(env, token.refreshToken),
    refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    repositoryAccessCacheExpiresAt: null,
  };
}

function dashboardAccessCacheTtlMs(env: Env): number {
  const parsed = Number.parseInt(env.DASHBOARD_ACCESS_CACHE_TTL_SECONDS ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return dashboardAccessCacheDefaultTtlSeconds * 1000;
  }

  return parsed * 1000;
}

function dashboardCallbackUrl(request: Request): string {
  const url = new URL(request.url);

  return `${url.origin}/dashboard/auth/github/callback`;
}

function dashboardLoginRedirectResponse(request?: Request, setCookie?: string): Response {
  const location =
    request === undefined
      ? "/dashboard/login/github"
      : `/dashboard/login/github?return_to=${encodeURIComponent(new URL(request.url).pathname)}`;
  const headers = new Headers({ location });

  if (setCookie !== undefined) {
    headers.set("set-cookie", setCookie);
  }

  return new Response(null, {
    headers,
    status: 302,
  });
}

function dashboardOauthStateFresh(issuedAt: string): boolean {
  const issuedAtMs = Date.parse(issuedAt);

  return !Number.isNaN(issuedAtMs) && Date.now() - issuedAtMs <= 10 * 60 * 1000;
}

function dashboardProblemResponse(status: number, headers?: HeadersInit): Response {
  return problemResponse(status, headers);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
    status: 200,
  });
}

function isExpired(value: string): boolean {
  return Date.parse(value) <= Date.now();
}

function isExpiredSoon(value: string): boolean {
  return Date.parse(value) <= Date.now() + 60 * 1000;
}

function requireDashboardClientId(env: Env): string {
  if (env.GITHUB_APP_CLIENT_ID === undefined || env.GITHUB_APP_CLIENT_ID.length === 0) {
    throw new Error("missing dashboard GitHub client id");
  }

  return env.GITHUB_APP_CLIENT_ID;
}

function sanitizeDashboardReturnTo(value: string | null): string {
  if (value === null || !value.startsWith("/dashboard")) {
    return "/dashboard";
  }

  return value;
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
