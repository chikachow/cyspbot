import { createGitHubWebhookReceiverWorker } from "@cyspbot/github-webhook-receiver/worker";
import type { GitHubWebhookReceiverDependencies } from "@cyspbot/github-webhook-receiver/github-webhooks/acceptance";

import { testEnv } from "./worker-env.ts";

type TestEnv = GitHubWebhookReceiverEnv;

const testNow = new Date("2026-05-24T00:00:00.000Z");

const testGitHubWebhookReceiverDependencies = {
  now: () => testNow,
} satisfies GitHubWebhookReceiverDependencies;

const githubWebhookReceiverApp = createGitHubWebhookReceiverWorker(
  testGitHubWebhookReceiverDependencies,
);

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
