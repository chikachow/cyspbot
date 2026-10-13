export async function forwardTokenRequest(request: Request, env: CyspbotEnv): Promise<Response> {
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
    const forwarded = new Request(endpoint, request);
    // The binding selects the service; the configured URL selects its App path.
    // Preserve edge identity and never trust a caller-supplied x-real-ip.
    forwarded.headers.delete("host");
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp === null) {
      forwarded.headers.delete("x-real-ip");
    } else {
      forwarded.headers.set("x-real-ip", clientIp);
    }
    const response = await env.GITHUB_APP_TOKEN_BROKER.fetch(
      new Request(forwarded, { redirect: "manual" }),
    );
    if (response.status >= 300 && response.status < 400) {
      // Cleanup must not delay rejection or disclose an upstream diagnostic.
      void response.body?.cancel().catch(() => undefined);
      return unavailableResponse();
    }
    return response;
  } catch {
    return unavailableResponse();
  }
}

function unavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
    status: 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
