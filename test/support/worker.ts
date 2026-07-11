import { createGitHubWebhookReceiverWorker } from "@cyspbot/github-webhook-receiver/worker";
import { createTokenExchangeWorker } from "@cyspbot/token-exchange/worker";
import type { GitHubWebhookReceiverDependencies } from "@cyspbot/github-webhook-receiver/dependencies";
import {
  createTokenExchangeRequestRuntime,
  type TokenExchangeRequestRuntime,
  type TokenExchangeWorkerDependencies,
} from "@cyspbot/token-exchange/dependencies";
import { handleTokenExchangeRequest } from "@cyspbot/token-exchange/token-exchange";

import { testNow } from "./constants.ts";
import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchOidcJwksTestDouble } from "./oidc.ts";
import { testTokenPolicyRules } from "./token-policy.ts";
import { testEnv } from "./worker-env.ts";

export {
  authorizationHeaders,
  createOidcToken,
  githubInstallationAccessTokenType,
  testPublicJwk,
  tokenExchangeRequestBody,
} from "./oidc.ts";
export { testEnv };

type TestDependencies = GitHubWebhookReceiverDependencies & TokenExchangeWorkerDependencies;
type TestBindings = GitHubWebhookReceiverBindings & TokenExchangeBindings;

const baseTestDependencies = {
  fetch: fetchGitHubTestDouble,
  fetchJwks: fetchOidcJwksTestDouble,
  now: () => testNow,
  tokenPolicyRules: testTokenPolicyRules,
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

export function fetchTokenExchangeWithDependencies(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  dependencies: Partial<TokenExchangeWorkerDependencies>,
): Promise<Response> {
  return fetchWorkerWithApp(
    createTokenExchangeWorker({
      ...baseTestDependencies,
      ...dependencies,
    }),
    input,
    init,
  );
}

export function fetchTokenExchangeWithRuntime(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  runtime: Partial<TokenExchangeRequestRuntime>,
): Promise<Response> {
  return handleTokenExchangeRequest(new Request(input, init), {
    ...createTokenExchangeRequestRuntime(testEnv, baseTestDependencies),
    ...runtime,
  });
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
