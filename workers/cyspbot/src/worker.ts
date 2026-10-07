import { forwardTokenRequest } from "./token-proxy.ts";

const rootDocument = "<!doctype html><title>cyspbot</title><p>beep, boop. i am a bot.</p>";

export function createCyspbotWorker(): ExportedHandler<CyspbotEnv> {
  return {
    fetch(request, env) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/token") {
        return forwardTokenRequest(request, env);
      }
      if (pathname !== "/") {
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
