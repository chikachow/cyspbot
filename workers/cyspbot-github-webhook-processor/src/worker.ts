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
          const fields = {
            attempts: message.attempts,
            deliveryId: job.deliveryId.slice(0, 128),
            error: error instanceof Error ? error.name : typeof error,
            ...errorLogFields(error),
            messageId: message.id,
            queue: batch.queue,
          };
          if (shouldRetry(error)) {
            console.warn("github_webhook_job_retrying", fields);
            if (error instanceof GitHubReactionError) {
              message.retry({
                delaySeconds:
                  error.retryDelaySeconds ??
                  Math.min(86_400, 60 * 2 ** Math.max(0, message.attempts - 1)),
              });
            } else {
              message.retry();
            }
          } else {
            console.error("github_webhook_job_failed", fields);
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

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof GitHubReactionError) {
    return { github: error.diagnostics, status: error.status };
  }

  if (error instanceof GitHubAppTokenBrokerError) {
    return {
      oauthErrorCode: oauthErrorCodes.has(error.oauthErrorCode)
        ? error.oauthErrorCode
        : "unrecognized_error",
      status: error.status,
    };
  }

  return {};
}

// Only known protocol codes are safe diagnostics; arbitrary broker text can contain credentials.
const oauthErrorCodes = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_token_type",
  "invalid_scope",
  "invalid_target",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "invalid_response",
]);
