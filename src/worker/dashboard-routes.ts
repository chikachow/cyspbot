import type { Env } from "../env.ts";
import {
  renderDashboardPullRequestHaikuPage,
  renderDashboardRepositoryDetailsPage,
  renderDashboardRepositoryListPage,
} from "../dashboard/html.ts";
import { parseDashboardRepositoryRoute } from "../dashboard/paths.ts";
import type { DashboardSession } from "../dashboard/types.ts";
import {
  getAccessibleDashboardRepositoryByFullName,
  listAccessibleDashboardRepositories,
  listDashboardPullRequestHaikuModel,
  setDashboardPullRequestHaikuOptIn,
} from "../dashboard/service.ts";
import {
  dashboardRedirectResponse,
  requireDashboardUserSession,
  responseForDashboardRepositoryAccessCheckError,
} from "../dashboard/user-authorization.ts";
import { problemResponse } from "../http/problem-details.ts";
import { listRepositoryAuditEntries } from "../storage/audit-log.ts";
import type { AppDependencies } from "./dependencies.ts";

export async function handleDashboardRepositoryListRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardUserSession(request, env, dependencies);

  if (dashboardSession.kind !== "authenticated") {
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
    const response = await responseForDashboardRepositoryAccessCheckError({
      env,
      request,
      error,
      githubUserId: dashboardSession.session.githubUserId,
      rawSessionToken: dashboardSession.rawSessionToken,
    });

    if (response !== null) {
      return response;
    }

    return problemResponse(503);
  }

  return htmlResponse(
    renderDashboardRepositoryListPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      repositories,
    }),
  );
}

export async function handleDashboardPullRequestHaikuRequest(
  request: Request,
  env: Env,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardUserSession(request, env, dependencies);

  if (dashboardSession.kind !== "authenticated") {
    return dashboardSession.response;
  }

  const now = dependencies.now().toISOString();

  if (request.method === "POST") {
    const response = await handlePullRequestHaikuToggleRequestWithAccessErrors({
      env,
      rawSessionToken: dashboardSession.rawSessionToken,
      session: dashboardSession.session,
      request,
      dependencies,
    });

    if (response !== null) {
      return response;
    }

    return dashboardRedirectResponse("/dashboard/pull-request-haikus");
  }

  let repositories: Awaited<ReturnType<typeof listDashboardPullRequestHaikuModel>>;

  try {
    repositories = await listDashboardPullRequestHaikuModel(
      env,
      dashboardSession.session,
      dependencies,
      now,
    );
  } catch (error) {
    const response = await responseForDashboardRepositoryAccessCheckError({
      env,
      request,
      error,
      githubUserId: dashboardSession.session.githubUserId,
      rawSessionToken: dashboardSession.rawSessionToken,
    });

    if (response !== null) {
      return response;
    }

    return problemResponse(503);
  }

  if (repositories === null) {
    return problemResponse(403);
  }

  return htmlResponse(
    renderDashboardPullRequestHaikuPage({
      githubLogin: dashboardSession.session.githubLoginDisplay,
      repositories,
    }),
  );
}

async function handlePullRequestHaikuToggleRequestWithAccessErrors(input: {
  dependencies: AppDependencies;
  env: Env;
  rawSessionToken: string;
  request: Request;
  session: DashboardSession;
}): Promise<Response | null> {
  try {
    return handlePullRequestHaikuToggleRequest(input);
  } catch (error) {
    const response = await responseForDashboardRepositoryAccessCheckError({
      env: input.env,
      request: input.request,
      error,
      githubUserId: input.session.githubUserId,
      rawSessionToken: input.rawSessionToken,
    });

    return response ?? problemResponse(503);
  }
}

export async function handleDashboardRepositoryDetailsRequest(
  request: Request,
  env: Env,
  pathname: string,
  dependencies: AppDependencies,
): Promise<Response> {
  const dashboardSession = await requireDashboardUserSession(request, env, dependencies);

  if (dashboardSession.kind !== "authenticated") {
    return dashboardSession.response;
  }

  const route = parseDashboardRepositoryRoute(pathname);

  if (route === null) {
    return problemResponse(404);
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
    const response = await responseForDashboardRepositoryAccessCheckError({
      env,
      request,
      error,
      githubUserId: dashboardSession.session.githubUserId,
      rawSessionToken: dashboardSession.rawSessionToken,
    });

    if (response !== null) {
      return response;
    }

    return problemResponse(503);
  }

  if (repository === null) {
    return problemResponse(404);
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

async function handlePullRequestHaikuToggleRequest(input: {
  dependencies: AppDependencies;
  env: Env;
  request: Request;
  session: DashboardSession;
}): Promise<Response | null> {
  if (!sameOrigin(input.request)) {
    return problemResponse(403);
  }

  if (!isFormContentType(input.request.headers.get("content-type"))) {
    return problemResponse(415);
  }

  const form = new URLSearchParams(new TextDecoder().decode(await input.request.arrayBuffer()));
  const repositoryId = parseRepositoryId(form.get("repository_id"));
  const action = form.get("action");

  if (repositoryId === null || (action !== "enable" && action !== "disable")) {
    return problemResponse(400);
  }

  const result = await setDashboardPullRequestHaikuOptIn(
    input.env,
    {
      enabled: action === "enable",
      repositoryId,
      session: input.session,
    },
    input.dependencies,
  );

  if (result === "forbidden") {
    return problemResponse(403);
  }

  if (result === "not_found") {
    return problemResponse(404);
  }

  return null;
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

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  return origin !== null && origin === new URL(request.url).origin;
}

function isFormContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function parseRepositoryId(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
