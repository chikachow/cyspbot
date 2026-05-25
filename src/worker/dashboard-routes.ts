import type { Env } from "../env.ts";
import {
  renderDashboardRepositoryDetailsPage,
  renderDashboardRepositoryListPage,
} from "../dashboard/html.ts";
import { parseDashboardRepositoryRoute } from "../dashboard/paths.ts";
import {
  getAccessibleDashboardRepositoryByFullName,
  listAccessibleDashboardRepositories,
} from "../dashboard/service.ts";
import {
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
