export async function githubWebhookProcessorOutboundService(request: Request): Promise<Response> {
  if (
    request.method !== "POST" ||
    request.url !== "https://api.github.com/repos/chikachow/cyspbot/issues/comments/42/reactions"
  ) {
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
  if (!request.headers.get("authorization")?.startsWith("Bearer ")) {
    throw new Error("GitHub request is missing Bearer authorization");
  }

  const body = (await request.json()) as { content?: unknown };
  if (body.content !== "eyes") {
    throw new Error("unexpected GitHub reaction request body");
  }

  return new Response(null, { status: 201 });
}
