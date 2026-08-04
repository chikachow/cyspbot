import { problemResponse } from "@cyspbot/http/problem-details";
import {
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import {
  createInstallationAccessTokenExchangeForWorker,
  defaultTokenExchangeWorkerDependencies,
} from "./dependencies.ts";
import type { TokenExchangeWorkerDependencies } from "./dependencies.ts";

export type { TokenExchangeWorkerDependencies } from "./dependencies.ts";

export function createTokenExchangeWorker(
  dependencies: TokenExchangeWorkerDependencies = defaultTokenExchangeWorkerDependencies,
): ExportedHandler<TokenExchangeEnv> {
  const exchange = createInstallationAccessTokenExchangeForWorker(dependencies);

  return {
    fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname !== "/token") {
        return problemResponse(404);
      }

      if (request.method !== "POST") {
        return tokenExchangeMethodNotAllowedResponse();
      }

      return handleTokenExchangeRequest(request, {
        exchange: (input) =>
          exchange.exchange({
            ...input,
            githubApp: githubApp(env),
          }),
        now: () => dependencies.now(),
        rateLimit: async (key) => {
          const result = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({ key });

          return result.success;
        },
      });
    },
  };
}

function githubApp(env: TokenExchangeEnv) {
  return {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL }),
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  };
}
