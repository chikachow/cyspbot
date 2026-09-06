const rootDocument = "<!doctype html><title>cyspbot</title><p>beep, boop. i am a bot.</p>";

export function createCyspbotWorker(): ExportedHandler<CyspbotEnv> {
  return {
    fetch(request) {
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
