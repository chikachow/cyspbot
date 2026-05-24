import type { Env } from "../env.ts";

export function maybeMockGitHubApiResponse(
  env: Env,
  path: string,
  method: string,
  headers: Headers,
  body?: string,
): Response | null {
  if (env.ENABLE_TEST_GITHUB_API !== "true") {
    return null;
  }

  const repository = env.TEST_GITHUB_REPOSITORY;
  const repositoryId = env.TEST_GITHUB_REPOSITORY_ID;
  const installationId = env.TEST_GITHUB_INSTALLATION_ID;
  const repositoryOwnerId = env.TEST_GITHUB_REPOSITORY_OWNER_ID;
  const repositoryVisibility = env.TEST_GITHUB_REPOSITORY_VISIBILITY;
  const dashboardUserId = env.TEST_GITHUB_DASHBOARD_USER_ID ?? "42";
  const dashboardUserLogin = env.TEST_GITHUB_DASHBOARD_USER_LOGIN ?? "sally";
  const dashboardAccessToken = env.TEST_GITHUB_DASHBOARD_ACCESS_TOKEN ?? "ghu_test_token";
  const dashboardRefreshToken = env.TEST_GITHUB_DASHBOARD_REFRESH_TOKEN ?? "ghr_test_token";

  if (
    repository === undefined ||
    repositoryId === undefined ||
    installationId === undefined ||
    repositoryOwnerId === undefined ||
    repositoryVisibility === undefined
  ) {
    return new Response(null, { status: 500 });
  }

  if (headers.get("authorization") === null) {
    if (method === "POST" && path === "/login/oauth/access_token") {
      return oauthTokenResponse(body, dashboardAccessToken, dashboardRefreshToken);
    }

    return new Response(null, { status: 401 });
  }

  const repositoryPath = `/repos/${repository}`;

  if (method === "GET" && path === "/user") {
    return Response.json({
      id: Number.parseInt(dashboardUserId, 10),
      login: dashboardUserLogin,
    });
  }

  if (method === "GET" && path.startsWith("/user/installations?")) {
    return Response.json({
      installations: [{ id: Number.parseInt(installationId, 10) }],
    });
  }

  if (method === "GET" && path.startsWith(`/user/installations/${installationId}/repositories?`)) {
    return Response.json({
      repositories: [
        {
          full_name: repository,
          id: Number.parseInt(repositoryId, 10),
          name: repository.split("/")[1],
          owner: {
            login: repository.split("/")[0],
          },
          permissions: {
            admin: true,
            pull: true,
            push: true,
          },
          private: repositoryVisibility !== "public",
        },
      ],
    });
  }

  if (method === "GET" && path === `${repositoryPath}/installation`) {
    return Response.json({ id: Number.parseInt(installationId, 10) });
  }

  if (method === "GET" && path === repositoryPath) {
    return Response.json({
      default_branch: env.TEST_GITHUB_DEFAULT_BRANCH ?? "main",
      id: Number.parseInt(repositoryId, 10),
      name: repository.split("/")[1],
      owner: {
        id: Number.parseInt(repositoryOwnerId, 10),
      },
      visibility: repositoryVisibility,
    });
  }

  if (method === "POST" && path === `/app/installations/${installationId}/access_tokens`) {
    if (headers.get("x-github-stateless-s2s-token") !== "enabled") {
      return new Response(null, { status: 500 });
    }

    const parsedBody = body === undefined ? null : (JSON.parse(body) as Record<string, unknown>);

    if (
      parsedBody === null ||
      !Array.isArray(parsedBody["repository_ids"]) ||
      parsedBody["repository_ids"].length !== 1 ||
      parsedBody["permissions"] !== undefined
    ) {
      return new Response(null, { status: 500 });
    }

    return Response.json(
      {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        token: env.TEST_GITHUB_MINTED_TOKEN ?? "ghs_test_token",
      },
      { status: 201 },
    );
  }

  return new Response(null, { status: 404 });
}

function oauthTokenResponse(
  body: string | undefined,
  accessToken: string,
  refreshToken: string,
): Response {
  const parsedBody = body === undefined ? new URLSearchParams() : new URLSearchParams(body);

  if (parsedBody.get("grant_type") === "refresh_token") {
    if (parsedBody.get("refresh_token") !== refreshToken) {
      return new Response(null, { status: 400 });
    }
  } else if (parsedBody.get("code") !== "test-dashboard-code") {
    return new Response(null, { status: 400 });
  }

  return Response.json({
    access_token: accessToken,
    expires_in: 28800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15897600,
  });
}
