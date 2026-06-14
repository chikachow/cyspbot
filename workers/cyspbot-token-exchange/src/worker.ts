import { problemResponse } from "@cyspbot/http/problem-details";
import {
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import {
  defaultTokenExchangeDependencies,
  type TokenExchangeDependencies,
} from "./dependencies.ts";

export function createTokenExchangeWorker(
  dependencies: TokenExchangeDependencies = defaultTokenExchangeDependencies,
): ExportedHandler<TokenExchangeBindings> {
  return {
    fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname !== "/token") {
        return problemResponse(404);
      }

      if (request.method !== "POST") {
        return tokenExchangeMethodNotAllowedResponse();
      }

      return handleTokenExchangeRequest(request, env, dependencies);
    },
  };
}
