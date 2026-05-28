import type { Env } from "../env.ts";
import {
  dashboardRedirectResponse,
  handleDashboardCallbackRequest,
  handleDashboardLoginRequest,
  handleDashboardLogoutRequest,
  handleGitHubAppSetupRequest,
} from "../dashboard/user-authorization.ts";
import {
  handleDashboardPullRequestHaikuRequest,
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
import { parsePullRequestHaikuQueueMessage } from "../pull-request-haiku/queue.ts";

type RouteHandler = (
  request: Request,
  env: Env,
  dependencies: AppDependencies,
  url: URL,
) => Promise<Response> | Response;

interface ExactRoute {
  handler: RouteHandler;
  methodNotAllowed?: () => Response;
  methods: readonly string[];
  path: string;
}

interface PrefixRoute {
  handler: RouteHandler;
  methodNotAllowed?: () => Response;
  methods: readonly string[];
  prefix: string;
}

type WorkerRoute = ExactRoute | PrefixRoute;

const workerRoutes: WorkerRoute[] = [
  {
    handler: () => dashboardRedirectResponse("/dashboard"),
    methods: ["GET"],
    path: "/",
  },
  {
    handler: (request, env, dependencies) => handleTokenExchangeRequest(request, env, dependencies),
    methodNotAllowed: tokenExchangeMethodNotAllowedResponse,
    methods: ["POST"],
    path: "/token",
  },
  {
    handler: (request, env, dependencies) => handleClaimsRequest(request, env, dependencies),
    methods: ["POST"],
    path: "/github/claims",
  },
  {
    handler: (request, env, dependencies) => handleGitHubWebhookRequest(request, env, dependencies),
    methods: ["POST"],
    path: "/github/webhooks",
  },
  {
    handler: (request) => handleGitHubAppSetupRequest(request),
    methods: ["GET"],
    path: "/github/setup",
  },
  {
    handler: (request, env) => handleDashboardLoginRequest(request, env),
    methods: ["GET"],
    path: "/login/github",
  },
  {
    handler: (request, env, dependencies) =>
      handleDashboardCallbackRequest(request, env, dependencies),
    methods: ["GET"],
    path: "/auth/github/callback",
  },
  {
    handler: (request, env) => handleDashboardLogoutRequest(request, env),
    methods: ["GET"],
    path: "/logout",
  },
  {
    handler: (request, env, dependencies) =>
      handleDashboardRepositoryListRequest(request, env, dependencies),
    methods: ["GET"],
    path: "/dashboard",
  },
  {
    handler: (request, env, dependencies) =>
      handleDashboardPullRequestHaikuRequest(request, env, dependencies),
    methods: ["GET", "POST"],
    path: "/dashboard/pull-request-haikus",
  },
  {
    handler: (request, env, dependencies, url) =>
      handleDashboardRepositoryDetailsRequest(request, env, url.pathname, dependencies),
    methods: ["GET"],
    prefix: "/dashboard/repositories/",
  },
];

export function createApp(
  dependencies: AppDependencies = defaultDependencies,
): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      const route = workerRoutes.find((candidate) => routeMatches(candidate, url.pathname));

      if (route === undefined) {
        return problemResponse(404);
      }

      if (!methodAllowed(route, request.method)) {
        return (
          route.methodNotAllowed?.() ?? problemResponse(405, { allow: route.methods.join(", ") })
        );
      }

      return route.handler(request, env, dependencies, url);
    },
    async queue(batch, env): Promise<void> {
      for (const message of batch.messages) {
        const pullRequestHaikuMessage = parsePullRequestHaikuQueueMessage(message.body);

        if (pullRequestHaikuMessage === null) {
          message.ack();
          continue;
        }

        try {
          await dependencies.processPullRequestHaikuMessage(env, pullRequestHaikuMessage);
          message.ack();
        } catch {
          message.retry({ delaySeconds: 60 });
        }
      }
    },
  };
}

export const app = createApp();

function routeMatches(route: WorkerRoute, pathname: string): boolean {
  return "path" in route ? route.path === pathname : pathname.startsWith(route.prefix);
}

function methodAllowed(route: WorkerRoute, method: string): boolean {
  return route.methods.includes(method);
}
