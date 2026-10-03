export async function tokenBrokerFixture(request: Request): Promise<Response> {
  if (request.url !== "https://broker.example/github/apps/example-app/token") {
    throw new Error("unexpected proxy destination");
  }
  return new Response(await request.arrayBuffer(), {
    status: 429,
    headers: {
      "content-type": request.headers.get("content-type") ?? "missing",
      "cache-control": "no-store",
      pragma: "no-cache",
      "retry-after": "30",
      "x-fixture-client-ip": request.headers.get("cf-connecting-ip") ?? "missing",
      "x-fixture-method": request.method,
    },
  });
}
