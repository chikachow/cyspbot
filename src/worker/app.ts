import type { Env } from "../env.ts";
import {
  clearDashboardSessionCookie,
  clearDashboardStateCookie,
  createDashboardSessionCookie,
  createSignedDashboardOauthStateCookie,
  randomToken,
  readDashboardOauthState,
  readDashboardSessionToken,
} from "../dashboard/auth.ts";
import {
  renderDashboardRepositoryDetailsPage,
  renderDashboardRepositoryListPage,
} from "../dashboard/html.ts";
import {
  authorizeTokenMintRequest,
  BrokerAuthorizationError,
  createRepositoryScopedInstallationToken,
  exchangeGitHubUserCode,
  getAuthenticatedGitHubUser,
  GitHubApiError,
  resolveInstallationForRepository,
  type GitHubApiDependencies,
} from "../github/api.ts";
import type { AuthenticatedContext } from "../oidc/principals.ts";
import type { SignalInstallationReconciliationResult } from "../durable-objects/installation-object.ts";
import {
  createAuditIntent,
  createDashboardSession,
  deleteDashboardSession,
  finalizeAuditEntry,
  getDashboardRepositoryByFullName,
  getDashboardSession,
  listRepositoryAuditEntries,
  listVisibleDashboardRepositories,
  markAuditFinalizationFailed,
  recordWebhookDelivery,
  refreshDashboardVisibility,
  userCanSeeRepository,
} from "../storage/d1.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  authenticateRequest as defaultAuthenticateRequest,
  type AuthenticateRequestResult,
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
const dashboardSessionMaxAgeSeconds = 8 * 60 * 60;

export interface AppDependencies extends GitHubApiDependencies {
  authenticateOidcToken(
    token: string,
    request: Request,
    env: Env,
  ): Promise<AuthenticateRequestResult>;
  authenticateRequest(request: Request, env: Env): Promise<AuthenticateRequestResult>;
  now(): Date;
}

const defaultDependencies: AppDependencies = {
  authenticateOidcToken: defaultAuthenticateOidcToken,
  authenticateRequest: defaultAuthenticateRequest,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

export function createApp(
  dependencies: AppDependencies = defaultDependencies,
): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/token") {
        if (request.method !== "POST") {
          return oauthErrorResponse(400, "invalid_request");
        }

        return handleTokenExchangeRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/claims") {
        if (request.method !== "POST") {
          return problemResponse(405, { allow: "POST" });
        }

        return handleClaimsRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/installations/token") {
        if (request.method !== "POST") {
          return problemResponse(405, { allow: "POST" });
        }

        return handleInstallationTokenRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/webhooks") {
        if (request.method !== "POST") {
          return problemResponse(405, { allow: "POST" });
        }

        return handleGitHubWebhookRequest(request, env, dependencies);
      }

      if (url.pathname === "/login/github") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardLoginRequest(request, env);
      }

      if (url.pathname === "/auth/github/callback") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardCallbackRequest(request, env, dependencies);
      }

      if (url.pathname === "/logout") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardLogoutRequest(request, env);
      }

      if (url.pathname === "/dashboard") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardRepositoryListRequest(request, env, dependencies);
      }

      if (url.pathname.startsWith("/dashboard/repositories/")) {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardRepositoryDetailsRequest(request, env, url.pathname, dependencies);
      }

      return problemResponse(404);
    },
  };
}

export const app = createApp();

async function handleClaimsRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const authentication = await dependencies.authenticateRequest(request, env);

  if (!authentication.ok) {
    return problemResponse(authentication.httpStatus, authentication.responseHeaders);
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return problemResponse(403);
  }

  try {
    await resolveInstallationForRepository(
      env,
      authentication.context.principal.repository,
      dependencies,
    );
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

async function handleInstallationTokenRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const authentication = await dependencies.authenticateRequest(request, env);

  if (!authentication.ok) {
    return problemResponse(authentication.httpStatus, authentication.responseHeaders);
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return problemResponse(403);
  }

  const result = await mintInstallationTokenForContext(env, authentication.context, dependencies);

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

async function handleTokenExchangeRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
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

  const authentication = await dependencies.authenticateOidcToken(subjectToken, request, env);

  if (!authentication.ok) {
    return oauthErrorResponse(
      authentication.httpStatus === 500 ? 500 : 400,
      authentication.httpStatus === 500 ? "server_error" : "invalid_request",
    );
  }

  if (!githubActionsPrincipal(authentication.context.principal)) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const result = await mintInstallationTokenForContext(env, authentication.context, dependencies);

  if (!result.ok) {
    return oauthErrorResponse(
      oauthStatusForMintFailure(result.status),
      oauthErrorCodeForMintFailure(result.status),
    );
  }

  return oauthTokenResponse({
    access_token: result.token,
    expires_in: expiresInSeconds(result.expiresAt, dependencies.now()),
    issued_token_type: githubInstallationAccessTokenType,
    token_type: "Bearer",
  });
}

interface MintResult {
  expiresAt: string;
  ok: true;
  token: string;
}

type MintInstallationTokenResult = MintResult | { ok: false; status: number };

async function mintInstallationTokenForContext(
  env: Env,
  authenticationContext: AuthenticatedContext,
  dependencies: AppDependencies,
): Promise<MintInstallationTokenResult> {
  const { issuerRegistration, principal, resolvedKeyId } = authenticationContext;
  const requestedAt = dependencies.now().toISOString();
  let auditIntent;
  let installationId: number | undefined;

  try {
    auditIntent = await createAuditIntent(
      env,
      principal,
      issuerRegistration.issuer,
      resolvedKeyId,
      requestedAt,
    );
  } catch (error) {
    console.error("Installation Token Issuance audit intent write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      eventName: principal.eventName,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    return { ok: false, status: 500 };
  }

  try {
    const installation = await resolveInstallationForRepository(
      env,
      principal.repository,
      dependencies,
    );
    installationId = installation.id;

    await authorizeTokenMintRequest(env, principal, dependencies);
    const token = await createRepositoryScopedInstallationToken(
      env,
      installation.id,
      principal.repositoryId,
      dependencies,
    );

    await finalizeAuditEntry(env, {
      auditEntryId: auditIntent.id,
      expiresAt: token.expiresAt,
      finalizedAt: dependencies.now().toISOString(),
      installationId: installation.id,
      outcome: "issued",
      permissions: token.permissions,
    });

    return {
      expiresAt: token.expiresAt,
      ok: true,
      token: token.token,
    };
  } catch (error) {
    const status = statusForTokenRequestError(error);
    const outcome = outcomeForTokenRequestError(error);
    const reasons = reasonsForTokenRequestError(error);

    console.error("GitHub installation token request failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      eventName: principal.eventName,
      installationId,
      outcome,
      ref: principal.ref,
      repository: principal.repository,
      repositoryId: principal.repositoryId,
    });

    try {
      await finalizeAuditEntry(env, {
        auditEntryId: auditIntent.id,
        finalizedAt: dependencies.now().toISOString(),
        installationId,
        outcome,
        reasons,
      });
    } catch (finalizationError) {
      console.error("Installation Token Issuance audit finalization failed", {
        auditEntryId: auditIntent.id,
        errorMessage:
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
      });

      try {
        await markAuditFinalizationFailed(env, auditIntent.id, dependencies.now().toISOString());
      } catch {
        // The pending audit intent remains the durable gap record.
      }

      return { ok: false, status: 500 };
    }

    return { ok: false, status };
  }
}

interface InstallationWebhookPayload {
  installation?: {
    id?: number;
  };
}

async function handleGitHubWebhookRequest(
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

async function handleDashboardCallbackRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const storedState = await readDashboardOauthState(request, env);

  if (
    code === null ||
    state === null ||
    storedState === null ||
    storedState.state !== state ||
    !dashboardOauthStateFresh(storedState.issuedAt, dependencies.now())
  ) {
    return dashboardProblemResponse(400, {
      "set-cookie": clearDashboardStateCookie(),
    });
  }

  try {
    const token = await exchangeGitHubUserCode(
      env,
      code,
      dashboardCallbackUrl(request),
      dependencies,
    );
    const user = await getAuthenticatedGitHubUser(env, token.accessToken, dependencies);
    const rawSessionToken = randomToken();
    const now = dependencies.now().toISOString();

    await createDashboardSession(env, {
      now,
      rawSessionToken,
      token,
      user,
    });

    const session = await getDashboardSession(env, rawSessionToken, now);

    if (session === null) {
      throw new Error("created dashboard session could not be read");
    }

    await refreshDashboardVisibility(env, session, dependencies, now);

    const headers = new Headers({
      location: storedState.returnTo,
    });
    headers.append("set-cookie", clearDashboardStateCookie());
    headers.append(
      "set-cookie",
      createDashboardSessionCookie(rawSessionToken, dashboardSessionMaxAgeSeconds),
    );

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
  const rawSessionToken = readDashboardSessionToken(request);

  if (rawSessionToken !== null) {
    await deleteDashboardSession(env, rawSessionToken);
  }

  return new Response(null, {
    headers: {
      location: "/dashboard",
      "set-cookie": clearDashboardSessionCookie(),
    },
    status: 302,
  });
}

async function handleDashboardRepositoryListRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardSession(request, env, dependencies);

  if (!dashboardSession.ok) {
    return dashboardSession.response;
  }

  const now = dependencies.now().toISOString();

  try {
    await refreshDashboardVisibility(env, dashboardSession.session, dependencies, now);
  } catch (error) {
    const response = await responseForDashboardVisibilityRefreshError(
      env,
      request,
      dashboardSession.rawSessionToken,
      dashboardSession.session.githubUserId,
      error,
    );

    if (response !== null) {
      return response;
    }
  }

  const repositories = await listVisibleDashboardRepositories(
    env,
    dashboardSession.session.githubUserId,
    now,
  );

  return htmlResponse(
    renderDashboardRepositoryListPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      repositories,
    }),
  );
}

async function handleDashboardRepositoryDetailsRequest(
  request: Request,
  env: Env,
  pathname: string,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardSession(request, env, dependencies);

  if (!dashboardSession.ok) {
    return dashboardSession.response;
  }

  const route = parseDashboardRepositoryRoute(pathname);

  if (route === null) {
    return dashboardProblemResponse(404);
  }

  const now = dependencies.now().toISOString();

  try {
    await refreshDashboardVisibility(env, dashboardSession.session, dependencies, now);
  } catch (error) {
    const response = await responseForDashboardVisibilityRefreshError(
      env,
      request,
      dashboardSession.rawSessionToken,
      dashboardSession.session.githubUserId,
      error,
    );

    if (response !== null) {
      return response;
    }

    return dashboardProblemResponse(503);
  }

  const repository = await getDashboardRepositoryByFullName(env, route.owner, route.name);

  if (repository === null) {
    return dashboardProblemResponse(404);
  }

  const authorized = await userCanSeeRepository(
    env,
    dashboardSession.session.githubUserId,
    repository.repositoryId,
    now,
  );

  if (!authorized) {
    return dashboardProblemResponse(404);
  }

  const tokenRequests = await listRepositoryAuditEntries(env, repository.repositoryId, 5);

  return htmlResponse(
    renderDashboardRepositoryDetailsPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      repository,
      tokenRequests,
    }),
  );
}

async function requireDashboardSession(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<
  | {
      ok: true;
      rawSessionToken: string;
      session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>;
    }
  | { ok: false; response: Response }
> {
  const rawSessionToken = readDashboardSessionToken(request);

  if (rawSessionToken === null) {
    return {
      ok: false,
      response: dashboardLoginRedirectResponse(request),
    };
  }

  const session = await getDashboardSession(env, rawSessionToken, dependencies.now().toISOString());

  if (session === null) {
    return {
      ok: false,
      response: dashboardLoginRedirectResponse(request, clearDashboardSessionCookie()),
    };
  }

  return {
    ok: true,
    rawSessionToken,
    session,
  };
}

async function responseForDashboardVisibilityRefreshError(
  env: Env,
  request: Request,
  rawSessionToken: string,
  githubUserId: string,
  error: unknown,
): Promise<Response | null> {
  console.error("dashboard_visibility_refresh_failed", {
    error_class: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    github_user_id: githubUserId,
    path: new URL(request.url).pathname,
  });

  if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
    await deleteDashboardSession(env, rawSessionToken);

    return dashboardLoginRedirectResponse(request, clearDashboardSessionCookie());
  }

  return null;
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

function statusForTokenRequestError(error: unknown): number {
  if (error instanceof BrokerAuthorizationError) {
    return 403;
  }

  return statusForGitHubApiError(error);
}

function outcomeForTokenRequestError(
  error: unknown,
): "denied" | "internal_error" | "upstream_error" {
  if (error instanceof BrokerAuthorizationError) {
    return "denied";
  }

  if (error instanceof GitHubApiError) {
    return error.status >= 500 ? "upstream_error" : "denied";
  }

  return "internal_error";
}

function reasonsForTokenRequestError(error: unknown): string[] {
  if (error instanceof BrokerAuthorizationError) {
    return error.policyDecision?.reasons.map(mapPolicyReason) ?? [];
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 404) {
      return ["github_installation_not_found"];
    }

    if (error.status === 429) {
      return ["github_upstream_rate_limited"];
    }

    if (error.status >= 500) {
      return ["github_upstream_unavailable"];
    }

    return ["github_upstream_unexpected_response"];
  }

  return ["internal_unexpected_error"];
}

function mapPolicyReason(reason: string): string {
  const mapped: Record<string, string> = {
    event_not_allowed: "policy_event_denied",
    ref_mismatch: "policy_ref_denied",
    ref_type_mismatch: "policy_ref_type_denied",
    repository_id_mismatch: "policy_repository_id_mismatch",
    repository_mismatch: "policy_repository_name_mismatch",
    repository_owner_id_mismatch: "policy_repository_owner_id_mismatch",
    repository_visibility_mismatch: "policy_repository_visibility_mismatch",
    subject_context_kind_mismatch: "policy_subject_mismatch",
    subject_context_not_allowed: "policy_subject_mismatch",
    subject_context_value_mismatch: "policy_subject_mismatch",
    subject_repository_mismatch: "policy_subject_mismatch",
  };

  return mapped[reason] ?? "internal_unexpected_error";
}

function dashboardCallbackUrl(request: Request): string {
  const url = new URL(request.url);

  return `${url.origin}/auth/github/callback`;
}

function dashboardLoginRedirectResponse(request?: Request, setCookie?: string): Response {
  const location =
    request === undefined
      ? "/login/github"
      : `/login/github?return_to=${encodeURIComponent(new URL(request.url).pathname)}`;
  const headers = new Headers({ location });

  if (setCookie !== undefined) {
    headers.set("set-cookie", setCookie);
  }

  return new Response(null, {
    headers,
    status: 302,
  });
}

function dashboardOauthStateFresh(issuedAt: string, now: Date): boolean {
  const issuedAtMs = Date.parse(issuedAt);

  return !Number.isNaN(issuedAtMs) && now.getTime() - issuedAtMs <= 10 * 60 * 1000;
}

function dashboardProblemResponse(status: number, headers?: HeadersInit): Response {
  return problemResponse(status, headers);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
    },
    status: 200,
  });
}

function parseDashboardRepositoryRoute(pathname: string): { name: string; owner: string } | null {
  const prefix = "/dashboard/repositories/";

  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const parts = pathname.slice(prefix.length).split("/");

  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }

  try {
    const owner = decodeURIComponent(parts[0]);
    const name = decodeURIComponent(parts[1]);

    if (owner.length === 0 || name.length === 0) {
      return null;
    }

    return { name, owner };
  } catch {
    return null;
  }
}

function requireDashboardClientId(env: Env): string {
  if (env.GITHUB_APP_CLIENT_ID === undefined || env.GITHUB_APP_CLIENT_ID.length === 0) {
    throw new Error("missing dashboard GitHub client id");
  }

  return env.GITHUB_APP_CLIENT_ID;
}

function sanitizeDashboardReturnTo(value: string | null): string {
  if (value === null) {
    return "/dashboard";
  }

  if (value === "/dashboard") {
    return value;
  }

  if (parseDashboardRepositoryRoute(value) !== null) {
    return value;
  }

  return "/dashboard";
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

function expiresInSeconds(expiresAt: string, now: Date): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
}
