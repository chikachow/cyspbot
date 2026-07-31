import { createGitHubWebhookReceiverWorker } from "@cyspbot/github-webhook-receiver/worker";
import { createTokenExchangeWorker } from "@cyspbot/token-exchange/worker";
import type { GitHubWebhookReceiverDependencies } from "@cyspbot/github-webhook-receiver/github-webhooks/acceptance";
import {
  createTokenExchangeRequestRuntimeFactory,
  defaultTokenExchangeWorkerDependencies,
  type TokenExchangeRequestRuntime,
  type TokenExchangeWorkerDependencies,
} from "@cyspbot/token-exchange/dependencies";
import { handleTokenExchangeRequest } from "@cyspbot/token-exchange/token-exchange";

import { testNow } from "./constants.ts";
import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./oidc.ts";
import { testTokenPolicyRules } from "./token-policy.ts";
import { testEnv } from "./worker-env.ts";

export {
  authorizationHeaders,
  githubInstallationAccessTokenType,
  tokenExchangeRequestBody,
} from "./oidc.ts";
export { testEnv };

type TestDependencies = GitHubWebhookReceiverDependencies & TokenExchangeWorkerDependencies;
type TestEnv = GitHubWebhookReceiverEnv & TokenExchangeEnv;

const baseTestDependencies = {
  ...defaultTokenExchangeWorkerDependencies,
  fetch: fetchTokenExchangeExternalTestDouble,
  now: () => testNow,
  tokenPolicy: testTokenPolicyRules,
} satisfies TestDependencies;

const tokenExchangeApp = createTokenExchangeWorker(baseTestDependencies);
const createTestTokenExchangeRequestRuntime =
  createTokenExchangeRequestRuntimeFactory(baseTestDependencies);
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
  env: TestEnv,
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
    ...createTestTokenExchangeRequestRuntime(testEnv),
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
  app: ExportedHandler<TestEnv>,
  input: RequestInfo | URL,
  init?: RequestInit,
  env: TestEnv = testEnv,
): Promise<Response> {
  const handler = app.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(new Request(input, init) as Parameters<typeof handler>[0], env, {} as ExecutionContext),
  );
}

function fetchTokenExchangeExternalTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const hostname = new URL(request.url).hostname;

  return oidcProviderHostnames.has(hostname)
    ? fetchOidcRemoteDocumentResponseTestDouble(request)
    : fetchGitHubTestDouble(request);
}

const oidcProviderHostnames = new Set([
  "accounts.google.com",
  "oidc.fly.io",
  "token.actions.githubusercontent.com",
  "www.googleapis.com",
]);
