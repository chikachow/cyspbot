import { readBodyUpTo } from "@cyspbot/http/body";
import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";
import {
  requestGitHubAppInstallationToken,
  type TokenExchangeEnvironment,
} from "@cyspbot/token-exchange";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const githubUserAgent = "cyspbot-github-webhook-processor";
const reactionContent = "eyes";
const reactionScope = "issues:write";
const maxGitHubReactionErrorBodyBytes = 16 * 1024;
const maxGitHubReactionDiagnosticValueLength = 1024;

export interface GitHubReactionErrorDiagnostics {
  readonly acceptedPermissions?: string | undefined;
  readonly documentationUrl?: string | undefined;
  readonly message?: string | undefined;
  readonly rateLimitRemaining?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfter?: string | undefined;
}

export interface GitHubReactionDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class GitHubReactionError extends Error {
  readonly diagnostics: GitHubReactionErrorDiagnostics;
  readonly rateLimited: boolean;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    rateLimited: boolean,
    diagnostics: GitHubReactionErrorDiagnostics = {},
  ) {
    super(`GitHub reaction request returned ${status}.`);
    this.name = "GitHubReactionError";
    this.diagnostics = diagnostics;
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
        "user-agent": githubUserAgent,
        "x-github-api-version": githubApiVersion,
      },
      method: "POST",
    },
  );

  if (response.status !== 200 && response.status !== 201) {
    const diagnostics = await readGitHubReactionErrorDiagnostics(response);

    throw new GitHubReactionError(
      response.status,
      response.status === 403 &&
        (response.headers.get("retry-after") !== null ||
          response.headers.get("x-ratelimit-remaining") === "0"),
      diagnostics,
    );
  }

  await response.body?.cancel();
}

async function readGitHubReactionErrorDiagnostics(
  response: Response,
): Promise<GitHubReactionErrorDiagnostics> {
  const acceptedPermissions = boundedHeaderValue(response, "x-accepted-github-permissions");
  const rateLimitRemaining = boundedHeaderValue(response, "x-ratelimit-remaining");
  const retryAfter = boundedHeaderValue(response, "retry-after");
  const requestId = boundedHeaderValue(response, "x-github-request-id");
  const headerDiagnostics = {
    ...(acceptedPermissions === undefined ? {} : { acceptedPermissions }),
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(requestId === undefined ? {} : { requestId }),
  };

  let body: Awaited<ReturnType<typeof readBodyUpTo>>;
  try {
    body = await readBodyUpTo(response.body, maxGitHubReactionErrorBodyBytes);
  } catch {
    return headerDiagnostics;
  }

  if (!body.ok) {
    return headerDiagnostics;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return headerDiagnostics;
  }

  if (!isRecord(value)) {
    return headerDiagnostics;
  }

  const message = boundedString(value["message"]);
  const documentationUrl = boundedString(value["documentation_url"]);

  return {
    ...headerDiagnostics,
    ...(message === undefined ? {} : { message }),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  };
}

function boundedHeaderValue(response: Response, name: string): string | undefined {
  return boundedString(response.headers.get(name));
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value.slice(0, maxGitHubReactionDiagnosticValueLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
