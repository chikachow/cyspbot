import type { Env } from "../env.ts";
import type { GitHubApiDependencies } from "../github/http.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  authenticateRequest as defaultAuthenticateRequest,
  type AuthenticateRequestResult,
} from "./authentication.ts";
import { processPullRequestHaikuMessage as defaultProcessPullRequestHaikuMessage } from "../pull-request-haiku/processor.ts";
import type { PullRequestHaikuQueueMessage } from "../pull-request-haiku/queue.ts";

export interface AppDependencies extends GitHubApiDependencies {
  authenticateOidcToken(
    token: string,
    request: Request,
    env: Env,
  ): Promise<AuthenticateRequestResult>;
  authenticateRequest(request: Request, env: Env): Promise<AuthenticateRequestResult>;
  enqueuePullRequestHaikuMessage(env: Env, message: PullRequestHaikuQueueMessage): Promise<void>;
  now(): Date;
  processPullRequestHaikuMessage(env: Env, message: PullRequestHaikuQueueMessage): Promise<void>;
}

export const defaultDependencies: AppDependencies = {
  authenticateOidcToken: defaultAuthenticateOidcToken,
  authenticateRequest: defaultAuthenticateRequest,
  enqueuePullRequestHaikuMessage: async (env, message) => {
    await env.PULL_REQUEST_HAIKU_QUEUE.send(message, { contentType: "json" });
  },
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  processPullRequestHaikuMessage: (env, message) =>
    defaultProcessPullRequestHaikuMessage(env, message, defaultDependencies),
};
