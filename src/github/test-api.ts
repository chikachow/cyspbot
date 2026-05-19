import type { Env } from "../env.ts";

export function maybeMockGitHubApiResponse(
  env: Env,
  path: string,
  method: string,
  headers: Headers,
): Response | null {
  if (env.ENABLE_TEST_GITHUB_API !== "true") {
    return null;
  }

  const repository = env.TEST_GITHUB_REPOSITORY;
  const repositoryId = env.TEST_GITHUB_REPOSITORY_ID;
  const installationId = env.TEST_GITHUB_INSTALLATION_ID;

  if (repository === undefined || repositoryId === undefined || installationId === undefined) {
    return new Response(null, { status: 500 });
  }

  if (headers.get("authorization") === null) {
    return new Response(null, { status: 401 });
  }

  const repositoryPath = `/repos/${repository}`;

  if (method === "GET" && path === `${repositoryPath}/installation`) {
    return Response.json({ id: Number.parseInt(installationId, 10) });
  }

  if (method === "GET" && path === repositoryPath) {
    return Response.json({
      default_branch: env.TEST_GITHUB_DEFAULT_BRANCH ?? "main",
      id: Number.parseInt(repositoryId, 10),
      name: repository.split("/")[1],
    });
  }

  if (method === "POST" && path === `/app/installations/${installationId}/access_tokens`) {
    return Response.json(
      {
        expires_at: "2030-01-01T00:00:00Z",
        token: env.TEST_GITHUB_MINTED_TOKEN ?? "ghs_test_token",
      },
      { status: 201 },
    );
  }

  return new Response(null, { status: 404 });
}
