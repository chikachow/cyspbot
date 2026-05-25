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
  getAccessibleDashboardRepositoryByFullName,
  listAccessibleDashboardRepositories,
} from "../dashboard/service.ts";
import {
  exchangeGitHubUserCode,
  getAuthenticatedGitHubUser,
  GitHubApiError,
} from "../github/api.ts";
import {
  createDashboardSession,
  deleteDashboardSession,
  getDashboardSession,
  listRepositoryAuditEntries,
} from "../storage/d1.ts";
import type { AppDependencies } from "./dependencies.ts";
import { problemResponse } from "./problem-details.ts";

const dashboardSessionMaxAgeSeconds = 8 * 60 * 60;

export function dashboardRedirectResponse(location: string): Response {
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location,
    },
    status: 302,
  });
}

export function handleGitHubAppSetupRequest(request: Request): Response {
  if (!isGitHubAppInstallationSetupCallback(new URL(request.url))) {
    return dashboardProblemResponse(400, {
      "set-cookie": clearDashboardStateCookie(),
    });
  }

  return dashboardLoginRedirectResponse(undefined, clearDashboardStateCookie(), "/dashboard");
}

export async function handleDashboardLoginRequest(request: Request, env: Env): Promise<Response> {
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

export async function handleDashboardCallbackRequest(
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

export async function handleDashboardLogoutRequest(request: Request, env: Env): Promise<Response> {
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

export async function handleDashboardRepositoryListRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardSession(request, env, dependencies);

  if (!dashboardSession.ok) {
    return dashboardSession.response;
  }

  const now = dependencies.now().toISOString();
  let repositories: Awaited<ReturnType<typeof listAccessibleDashboardRepositories>>;

  try {
    repositories = await listAccessibleDashboardRepositories(
      env,
      dashboardSession.session,
      dependencies,
      now,
    );
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

  return htmlResponse(
    renderDashboardRepositoryListPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      repositories,
    }),
  );
}

export async function handleDashboardRepositoryDetailsRequest(
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
  let repository: Awaited<ReturnType<typeof getAccessibleDashboardRepositoryByFullName>>;

  try {
    repository = await getAccessibleDashboardRepositoryByFullName(
      env,
      dashboardSession.session,
      route.owner,
      route.name,
      dependencies,
      now,
    );
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

  if (repository === null) {
    return dashboardProblemResponse(404);
  }

  const issuanceAttempts = await listRepositoryAuditEntries(env, repository.repositoryId, 5);

  return htmlResponse(
    renderDashboardRepositoryDetailsPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      issuanceAttempts,
      repository,
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

function dashboardCallbackUrl(request: Request): string {
  const url = new URL(request.url);

  return `${url.origin}/auth/github/callback`;
}

function dashboardLoginRedirectResponse(
  request?: Request,
  setCookie?: string,
  returnTo?: string,
): Response {
  const location =
    returnTo !== undefined
      ? `/login/github?return_to=${encodeURIComponent(returnTo)}`
      : request === undefined
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

function isGitHubAppInstallationSetupCallback(url: URL): boolean {
  const installationId = Number.parseInt(url.searchParams.get("installation_id") ?? "", 10);
  const setupAction = url.searchParams.get("setup_action");

  return (
    Number.isSafeInteger(installationId) &&
    installationId > 0 &&
    (setupAction === "install" || setupAction === "update")
  );
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
