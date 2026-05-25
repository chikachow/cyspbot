import type { Env } from "../env.ts";
import {
  dashboardRedirectResponse,
  handleDashboardCallbackRequest,
  handleDashboardLoginRequest,
  handleDashboardLogoutRequest,
  handleGitHubAppSetupRequest,
} from "../dashboard/user-authorization.ts";
import {
  handleDashboardRepositoryDetailsRequest,
  handleDashboardRepositoryListRequest,
} from "./dashboard-routes.ts";
import { defaultDependencies, type AppDependencies } from "./dependencies.ts";
import { problemResponse } from "../http/problem-details.ts";
import {
  handleClaimsRequest,
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import { handleGitHubWebhookRequest } from "./webhook.ts";

export function createApp(
  dependencies: AppDependencies = defaultDependencies,
): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return dashboardRedirectResponse("/dashboard");
      }

      if (url.pathname === "/token") {
        if (request.method !== "POST") {
          return tokenExchangeMethodNotAllowedResponse();
        }

        return handleTokenExchangeRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/claims") {
        if (request.method !== "POST") {
          return problemResponse(405, { allow: "POST" });
        }

        return handleClaimsRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/webhooks") {
        if (request.method !== "POST") {
          return problemResponse(405, { allow: "POST" });
        }

        return handleGitHubWebhookRequest(request, env, dependencies);
      }

      if (url.pathname === "/github/setup") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleGitHubAppSetupRequest(request);
      }

      if (url.pathname === "/login/github") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardLoginRequest(request, env);
      }

      if (url.pathname === "/auth/github/callback") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardCallbackRequest(request, env, dependencies);
      }

      if (url.pathname === "/logout") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardLogoutRequest(request, env);
      }

      if (url.pathname === "/dashboard") {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardRepositoryListRequest(request, env, dependencies);
      }

      if (url.pathname.startsWith("/dashboard/repositories/")) {
        if (request.method !== "GET") {
          return problemResponse(405, { allow: "GET" });
        }

        return handleDashboardRepositoryDetailsRequest(request, env, url.pathname, dependencies);
      }

      return problemResponse(404);
    },
  };
}

export const app = createApp();
