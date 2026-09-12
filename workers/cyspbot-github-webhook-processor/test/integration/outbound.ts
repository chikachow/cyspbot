export async function githubWebhookProcessorOutboundService(request: Request): Promise<Response> {
  const statuses = new Map([
    ["https://api.github.com/repos/chikachow/cyspbot/issues/comments/42/reactions", 201],
    ["https://api.github.com/repos/chikachow/cyspbot/issues/comments/43/reactions", 200],
    ["https://api.github.com/repos/chikachow/cyspbot/issues/comments/44/reactions", 503],
    ["https://api.github.com/repos/chikachow/cyspbot/issues/comments/45/reactions", 301],
    ["https://api.github.com/repositories/123/issues/comments/45/reactions", 201],
  ]);
  const status = statuses.get(request.url);
  if (request.method !== "POST" || status === undefined) {
    throw new Error(`unexpected outbound request: ${request.method} ${request.url}`);
  }

  if (request.headers.get("accept") !== "application/vnd.github+json") {
    throw new Error("unexpected GitHub Accept header");
  }
  if (request.headers.get("content-type") !== "application/json") {
    throw new Error("unexpected GitHub Content-Type header");
  }
  if (request.headers.get("user-agent") !== "cyspbot-github-webhook-processor") {
    throw new Error("unexpected GitHub User-Agent header");
  }
  if (request.headers.get("x-github-api-version") !== "2022-11-28") {
    throw new Error("unexpected GitHub API version header");
  }
  if (request.headers.get("authorization") !== "Bearer ghs_integration_token") {
    throw new Error("GitHub request is missing Bearer authorization");
  }

  const body = (await request.json()) as { content?: unknown };
  if (body.content !== "eyes") {
    throw new Error("unexpected GitHub reaction request body");
  }

  return new Response(null, {
    status,
    ...(status === 301
      ? {
          headers: {
            location: "https://api.github.com/repositories/123/issues/comments/45/reactions",
          },
        }
      : {}),
  });
}

export async function githubWebhookProcessorBrokerService(request: Request): Promise<Response> {
  if (
    request.url !== "https://github-app-token-broker-local/token" ||
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/x-www-form-urlencoded"
  ) {
    throw new Error("unexpected broker request");
  }
  const form = new URLSearchParams(await request.text());
  const expected = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    resource: "https://api.github.com/repos/chikachow/cyspbot",
    scope: "issues:write pull_requests:write",
    subject_token: "eyJ.integration.workload.identity",
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  };
  if (
    form.size !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => form.get(key) !== value)
  ) {
    throw new Error("unexpected token exchange parameters");
  }
  return Response.json({
    access_token: "ghs_integration_token",
    expires_in: 300,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "issues:write pull_requests:write",
    token_type: "Bearer",
  });
}
