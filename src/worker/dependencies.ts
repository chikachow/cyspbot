import type { Env } from "../env.ts";
import type { GitHubApiDependencies } from "../github/http.ts";
import { pullRequestHaikuFeatureEnabled } from "../pull-request-haiku/feature-flag.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  authenticateRequest as defaultAuthenticateRequest,
  type AuthenticateRequestResult,
} from "./authentication.ts";
import { processPullRequestHaikuMessage as defaultProcessPullRequestHaikuMessage } from "../pull-request-haiku/processor.ts";
import type { PullRequestHaikuQueueMessage } from "../pull-request-haiku/queue.ts";
import {
  pullRequestHaikuRepositoryOptedIn,
  recordPullRequestHaikuQueued,
} from "../storage/pull-request-haiku.ts";
import type { WebhookDeliveryAcceptanceDependencies } from "../webhook/delivery-acceptance.ts";

export interface AppDependencies
  extends GitHubApiDependencies, WebhookDeliveryAcceptanceDependencies {
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
  pullRequestHaikuFeatureEnabled,
  pullRequestHaikuRepositoryOptedIn,
  processPullRequestHaikuMessage: (env, message) =>
    defaultProcessPullRequestHaikuMessage(env, message, defaultDependencies),
  reconcileInstallation: (env, installationId) =>
    env.GITHUB_INSTALLATION.getByName(String(installationId)).signalInstallationReconciliation({
      installationId,
      signalSource: "webhook",
    }),
  recordPullRequestHaikuQueued,
};
