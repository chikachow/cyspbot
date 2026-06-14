import type { GitHubWebhookReceiverDependencies as BaseGitHubWebhookReceiverDependencies } from "./github-webhooks/acceptance.ts";

export type GitHubWebhookReceiverDependencies = BaseGitHubWebhookReceiverDependencies;

export const defaultGitHubWebhookReceiverDependencies: GitHubWebhookReceiverDependencies = {
  now: () => new Date(),
};
