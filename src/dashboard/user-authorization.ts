import type { Env } from "../env.ts";
import {
  exchangeGitHubUserCode,
  getAuthenticatedGitHubUser,
  GitHubApiError,
  type GitHubApiDependencies,
} from "../github/api.ts";
import {
  createDashboardSession,
  deleteDashboardSession,
  getDashboardSession,
} from "../storage/dashboard-session-store.ts";
import { problemResponse } from "../http/problem-details.ts";
import {
  clearDashboardSessionCookie,
  clearDashboardStateCookie,
  createDashboardSessionCookie,
  createSignedDashboardOauthStateCookie,
  randomToken,
  readDashboardOauthState,
  readDashboardSessionToken,
} from "./auth.ts";
import { sanitizeDashboardReturnTo } from "./paths.ts";
import type { DashboardSession } from "./types.ts";

const dashboardSessionMaxAgeSeconds = 8 * 60 * 60;
const dashboardOauthStateMaxAgeMs = 10 * 60 * 1000;

export interface DashboardUserAuthorizationDependencies extends GitHubApiDependencies {
  now(): Date;
}

export type DashboardUserSessionRequirement =
  | {
      kind: "authenticated";
      rawSessionToken: string;
      session: DashboardSession;
    }
  | { kind: "login_required"; response: Response };

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
    return problemResponse(400, {
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
  dependencies: DashboardUserAuthorizationDependencies,
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
    return problemResponse(400, {
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

    return problemResponse(502, {
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

export async function requireDashboardUserSession(
  request: Request,
  env: Env,
  dependencies: DashboardUserAuthorizationDependencies,
): Promise<DashboardUserSessionRequirement> {
  const rawSessionToken = readDashboardSessionToken(request);

  if (rawSessionToken === null) {
    return {
      kind: "login_required",
      response: dashboardLoginRedirectResponse(request),
    };
  }

  const session = await getDashboardSession(env, rawSessionToken, dependencies.now().toISOString());

  if (session === null) {
    return {
      kind: "login_required",
      response: dashboardLoginRedirectResponse(request, clearDashboardSessionCookie()),
    };
  }

  return {
    kind: "authenticated",
    rawSessionToken,
    session,
  };
}

export async function responseForDashboardRepositoryAccessCheckError(input: {
  env: Env;
  error: unknown;
  githubUserId: string;
  rawSessionToken: string;
  request: Request;
}): Promise<Response | null> {
  console.error("dashboard_visibility_refresh_failed", {
    error_class: input.error instanceof Error ? input.error.name : typeof input.error,
    errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
    github_user_id: input.githubUserId,
    path: new URL(input.request.url).pathname,
  });

  if (
    input.error instanceof GitHubApiError &&
    (input.error.status === 401 || input.error.status === 403)
  ) {
    await deleteDashboardSession(input.env, input.rawSessionToken);

    return dashboardLoginRedirectResponse(input.request, clearDashboardSessionCookie());
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

  return !Number.isNaN(issuedAtMs) && now.getTime() - issuedAtMs <= dashboardOauthStateMaxAgeMs;
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

function requireDashboardClientId(env: Env): string {
  if (env.GITHUB_APP_CLIENT_ID === undefined || env.GITHUB_APP_CLIENT_ID.length === 0) {
    throw new Error("missing dashboard GitHub client id");
  }

  return env.GITHUB_APP_CLIENT_ID;
}
