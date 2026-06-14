import {
  testInstallationId,
  testRepository,
  testRepositoryId,
  testRepositoryOwnerId,
  testRepositoryVisibility,
} from "./constants.ts";

export async function fetchGitHubTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const apiPath = gitHubApiPathForTestDouble(request);

  if (apiPath === null) {
    return new Response(null, { status: 404 });
  }

  if (request.headers.get("authorization") === null) {
    return new Response(null, { status: 401 });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/installation`) {
    return Response.json({ id: testInstallationId });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}`) {
    return Response.json({
      default_branch: "main",
      id: Number.parseInt(testRepositoryId, 10),
      owner: {
        id: Number.parseInt(testRepositoryOwnerId, 10),
      },
      visibility: testRepositoryVisibility,
    });
  }

  if (
    request.method === "POST" &&
    apiPath === `/app/installations/${testInstallationId}/access_tokens`
  ) {
    const body = (await request.json()) as Record<string, unknown>;
    const permissions = body["permissions"];

    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("x-github-stateless-s2s-token") !== "enabled" ||
      !Array.isArray(body["repository_ids"]) ||
      body["repository_ids"][0] !== Number.parseInt(testRepositoryId, 10) ||
      permissions === null ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      return new Response(null, { status: 500 });
    }

    const requestedPermissions = permissions as Record<string, unknown>;

    if (
      Object.keys(requestedPermissions).length === 1 &&
      requestedPermissions["metadata"] === "read"
    ) {
      return Response.json(
        {
          expires_at: "2030-01-01T00:00:00Z",
          permissions: {
            metadata: "read",
          },
          token: "ghs_test_metadata_token",
        },
        { status: 201 },
      );
    }

    if (
      Object.keys(requestedPermissions).length !== 2 ||
      requestedPermissions["contents"] !== "write" ||
      requestedPermissions["pull_requests"] !== "write"
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
        token: "ghs_test_token",
      },
      { status: 201 },
    );
  }

  return new Response(`No test GitHub response for ${request.method} ${path}`, { status: 404 });
}

function gitHubApiPathForTestDouble(request: Request): string | null {
  const url = new URL(request.url);

  if (url.hostname !== "example.test" && url.hostname !== "api.github.com") {
    return null;
  }

  return url.pathname.replace(/^\/__test\/github/u, "");
}
