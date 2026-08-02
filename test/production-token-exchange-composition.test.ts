import { describe, expect, it } from "vitest";

import { createTokenExchangeWorker } from "@cyspbot/token-exchange/worker";
import { defaultTokenExchangeWorkerDependencies } from "@cyspbot/token-exchange/dependencies";
import { githubInstallationAccessTokenType, testNow } from "./support/constants.ts";
import {
  fetchOidcRemoteDocumentResponseTestDouble,
  tokenExchangeRequestBody,
} from "./support/oidc.ts";
import type { TokenExchangeRequestBodyOptions } from "./support/oidc-token.ts";
import { testEnv } from "./support/worker-env.ts";

describe("production token-exchange composition", () => {
  it("exchanges an allowed GitHub Actions token without broadening requested permissions", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: "chikachow/cyspbot",
        sub: "customized-production-subject",
        workflow_ref: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/cyspbot",
        scope: "pull_requests:read contents:read",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_production_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:read pull_requests:read",
      token_type: "Bearer",
    });
    expect(fixture.installationAccessTokenRequests).toEqual([
      {
        permissions: { contents: "read", pull_requests: "read" },
        repositories: ["cyspbot"],
      },
    ]);
  });

  it("returns invalid_request for a policy-unacceptable Google subject token", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        azp: "107517467455664443765",
        sub: "107517467455664443765",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/cyspbot",
        scope: "contents:read",
      },
      tokenOptions: {
        issuer: "https://accounts.google.com",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fixture.githubRequests).toEqual([]);
  });
});

function createProductionTokenExchangeFixture() {
  const githubRequests: string[] = [];
  const installationAccessTokenRequests: unknown[] = [];
  const fetchExternal: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (oidcProviderHostnames.has(url.hostname)) {
      return fetchOidcRemoteDocumentResponseTestDouble(request);
    }

    if (url.hostname === "api.github.com") {
      githubRequests.push(`${request.method} ${url.href}`);
    }

    if (
      request.method === "GET" &&
      url.href === "https://api.github.com/repos/chikachow/cyspbot/installation"
    ) {
      return Response.json({ account: { login: "chikachow" }, id: 13_579 });
    }

    if (
      request.method === "POST" &&
      url.href === "https://api.github.com/app/installations/13579/access_tokens"
    ) {
      const body: unknown = await request.json();
      installationAccessTokenRequests.push(body);

      return Response.json(
        {
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read", pull_requests: "read" },
          token: "ghs_production_test_token",
        },
        { status: 201 },
      );
    }

    return new Response(`Unexpected external request: ${request.method} ${request.url}`, {
      status: 404,
    });
  };
  const worker = createTokenExchangeWorker({
    ...defaultTokenExchangeWorkerDependencies,
    fetch: fetchExternal,
    now: () => testNow,
  });

  return {
    fetchTokenExchange: async (options: TokenExchangeRequestBodyOptions) => {
      const handler = worker.fetch;

      if (handler === undefined) {
        throw new Error("production token-exchange fixture has no fetch handler");
      }

      return Promise.resolve(
        handler(
          new Request("https://example.test/token", {
            body: await tokenExchangeRequestBody(options),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }) as Parameters<typeof handler>[0],
          testEnv,
          {} as ExecutionContext,
        ),
      );
    },
    githubRequests,
    installationAccessTokenRequests,
  };
}

const oidcProviderHostnames = new Set([
  "accounts.google.com",
  "token.actions.githubusercontent.com",
  "www.googleapis.com",
]);
