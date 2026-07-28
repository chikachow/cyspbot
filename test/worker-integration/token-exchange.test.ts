import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  flyOidcIntegrationIssuer,
  tokenExchangeOidcIntegrationCases,
} from "../support/oidc-integration-cases.ts";
import { createTokenExchangeRequestBody } from "../support/oidc-token.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      OIDC_TEST_PRIVATE_KEY: string;
    }
  }
}

describe("token exchange Worker OIDC discovery", () => {
  it.each(tokenExchangeOidcIntegrationCases)("$scenario", async (testCase) => {
    const { error, organizationSlug, status } = testCase;
    const response = await exports.default.fetch("https://example.test/token", {
      body: await createTokenExchangeRequestBody(env.OIDC_TEST_PRIVATE_KEY, {
        claims: {
          app_name: "fixture-app",
          machine_name: "fixture-machine",
          org_name: organizationSlug,
          sub: `${organizationSlug}:fixture-app:fixture-machine`,
        },
        form: {
          resource: "https://api.github.com/repos/fixture-owner/unconfigured-target",
          scope: "contents:read",
        },
        tokenOptions: {
          issuer: flyOidcIntegrationIssuer(testCase),
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });
});
