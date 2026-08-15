import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import {
  requestGitHubAppInstallationToken,
  type TokenExchangeEnvironment,
} from "@cyspbot/token-exchange";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const reactionContent = "eyes";
const reactionScope = "issues:write";

export interface GitHubReactionDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class GitHubReactionError extends Error {
  readonly rateLimited: boolean;
  readonly retryable: boolean;
  readonly status: number;

  constructor(status: number, rateLimited: boolean) {
    super(`GitHub reaction request returned ${status}.`);
    this.name = "GitHubReactionError";
    this.rateLimited = rateLimited;
    this.retryable = status === 429 || status >= 500 || rateLimited;
    this.status = status;
  }
}

export async function addStatusReaction(
  env: TokenExchangeEnvironment,
  job: GitHubIssueCommentStatusReactionJob,
  dependencies: GitHubReactionDependencies,
): Promise<void> {
  const repositoryPath = `${encodeURIComponent(job.repository.owner)}/${encodeURIComponent(job.repository.name)}`;
  const resource = `${githubApiBaseUrl}/repos/${repositoryPath}`;
  const token = await requestGitHubAppInstallationToken(env, {
    resource,
    scope: reactionScope,
  });

  const response = await dependencies.fetch(
    `${resource}/issues/comments/${job.commentId}/reactions`,
    {
      body: JSON.stringify({ content: reactionContent }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        "x-github-api-version": githubApiVersion,
      },
      method: "POST",
    },
  );

  await response.body?.cancel();

  if (response.status !== 200 && response.status !== 201) {
    throw new GitHubReactionError(
      response.status,
      response.status === 403 &&
        (response.headers.get("retry-after") !== null ||
          response.headers.get("x-ratelimit-remaining") === "0"),
    );
  }
}
