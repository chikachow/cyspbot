import { createGitHubWebhookReceiverWorker } from "../../src/worker.ts";

import { testEnv } from "./worker-env.ts";

type TestEnv = GitHubWebhookReceiverEnv;

const githubWebhookReceiverApp = createGitHubWebhookReceiverWorker();

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
