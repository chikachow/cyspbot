const rootDocument = "<!doctype html><title>cyspbot</title><p>beep, boop. i am a bot.</p>";

export function createCyspbotWorker(): ExportedHandler<CyspbotEnv> {
  return {
    fetch(request, env) {
      if (new URL(request.url).pathname === "/token") {
        return forwardTokenRequest(request, env);
      }
      if (new URL(request.url).pathname !== "/") {
        return new Response(null, { status: 404 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
          headers: { allow: "GET, HEAD" },
          status: 405,
        });
      }
      return new Response(request.method === "HEAD" ? null : rootDocument, {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    },
  };
}

async function forwardTokenRequest(request: Request, env: CyspbotEnv): Promise<Response> {
  try {
    const endpoint = new URL(env.TOKEN_PROXY_ENDPOINT);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      !/^\/github\/apps\/[a-z0-9]+(?:-[a-z0-9]+)*\/token$/.test(endpoint.pathname)
    ) {
      throw new TypeError("invalid token endpoint configuration");
    }
    // Forward the edge-supplied admission identity and untouched body through the
    // deployment-owned binding. The broker owns authentication and body limits.
    const forwarded = new Request(endpoint, request);
    return await env.GITHUB_APP_TOKEN_BROKER.fetch(new Request(forwarded, { redirect: "manual" }));
  } catch {
    return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    });
  }
}
