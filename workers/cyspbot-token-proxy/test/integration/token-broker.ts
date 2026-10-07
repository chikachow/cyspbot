export async function tokenBrokerFixture(request: Request): Promise<Response> {
  if (request.url !== "https://broker.example/github/apps/example-app/token") {
    throw new Error("unexpected proxy destination");
  }
  if (request.headers.get("x-fixture-response") === "redirect") {
    return new Response("upstream diagnostic", {
      status: 307,
      headers: { location: "https://untrusted.example/" },
    });
  }
  return new Response(await request.arrayBuffer(), {
    status: 429,
    headers: {
      "content-type": request.headers.get("content-type") ?? "missing",
      "cache-control": "no-store",
      pragma: "no-cache",
      "retry-after": "30",
      "x-fixture-method": request.method,
      "x-fixture-real-ip": request.headers.get("x-real-ip") ?? "missing",
      "x-fixture-host": request.headers.get("host") ?? "missing",
    },
  });
}
