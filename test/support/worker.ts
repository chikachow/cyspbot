import { authenticateOidcToken } from "@cyspbot/token-exchange/authentication";
import { createGitHubWebhookReceiverWorker } from "@cyspbot/github-webhook-receiver/worker";
import { createTokenExchangeWorker } from "@cyspbot/token-exchange/worker";
import type { GitHubWebhookReceiverDependencies } from "@cyspbot/github-webhook-receiver/dependencies";
import type { TokenExchangeDependencies } from "@cyspbot/token-exchange/dependencies";

import { testNow } from "./constants.ts";
import { fetchGitHubTestDouble } from "./github-api.ts";
import { testOidcVerifier } from "./oidc.ts";
import { testEnv } from "./worker-env.ts";

export {
  authorizationHeaders,
  createOidcToken,
  githubInstallationAccessTokenType,
  testPublicJwk,
  tokenExchangeRequestBody,
} from "./oidc.ts";
export { testEnv };

type TestDependencies = GitHubWebhookReceiverDependencies & TokenExchangeDependencies;
type TestBindings = GitHubWebhookReceiverBindings & TokenExchangeBindings;

const baseTestDependencies = {
  authenticateOidcToken: (token, request) =>
    authenticateOidcToken(token, request, testOidcVerifier),
  fetch: fetchGitHubTestDouble,
  now: () => testNow,
} satisfies TestDependencies;

const tokenExchangeApp = createTokenExchangeWorker(baseTestDependencies);
const githubWebhookReceiverApp = createGitHubWebhookReceiverWorker(baseTestDependencies);

export function fetchTokenExchange(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWorkerWithApp(tokenExchangeApp, input, init);
}

export function fetchTokenExchangeWithEnv(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  env: TestBindings,
): Promise<Response> {
  return fetchWorkerWithApp(tokenExchangeApp, input, init, env);
}

export function fetchGitHubWebhookReceiver(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWorkerWithApp(githubWebhookReceiverApp, input, init);
}

function fetchWorkerWithApp(
  app: ExportedHandler<TestBindings>,
  input: RequestInfo | URL,
  init?: RequestInit,
  env: TestBindings = testEnv,
): Promise<Response> {
  const handler = app.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(new Request(input, init) as Parameters<typeof handler>[0], env, {} as ExecutionContext),
  );
}
