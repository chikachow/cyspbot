import { parseGitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import { GitHubAppTokenBrokerError } from "@cyspbot/token-exchange";
import {
  addStatusReaction,
  GitHubReactionError,
  type GitHubReactionDependencies,
} from "./github/reactions.ts";

const defaultDependencies: GitHubReactionDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

export function createGitHubWebhookProcessorWorker(
  dependencies: GitHubReactionDependencies = defaultDependencies,
): ExportedHandler<GitHubWebhookProcessorEnv, unknown> {
  return {
    async queue(batch, env) {
      for (const message of batch.messages) {
        const job = parseGitHubIssueCommentStatusReactionJob(message.body);

        if (job === undefined) {
          console.warn("github_webhook_job_rejected", {
            attempts: message.attempts,
            messageId: message.id,
            queue: batch.queue,
            reason: "invalid_job",
          });
          message.ack();
          continue;
        }

        try {
          await addStatusReaction(env, job, dependencies);
          message.ack();
        } catch (error) {
          if (shouldRetry(error)) {
            console.warn("github_webhook_job_retrying", {
              attempts: message.attempts,
              error: errorName(error),
              messageId: message.id,
              queue: batch.queue,
              status: errorStatus(error),
            });
            message.retry();
          } else {
            console.error("github_webhook_job_failed", {
              attempts: message.attempts,
              error: errorName(error),
              messageId: message.id,
              queue: batch.queue,
              status: errorStatus(error),
            });
            message.ack();
          }
        }
      }
    },
  };
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof GitHubReactionError) {
    return error.retryable;
  }

  if (error instanceof GitHubAppTokenBrokerError) {
    return error.status === 429 || error.status >= 500;
  }

  return true;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  return typeof error;
}

function errorStatus(error: unknown): number | undefined {
  if (error instanceof GitHubReactionError || error instanceof GitHubAppTokenBrokerError) {
    return error.status;
  }

  return undefined;
}
