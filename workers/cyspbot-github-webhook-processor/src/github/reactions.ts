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
const reactionScope = "issues:write pull_requests:write";
const maxGitHubReactionErrorBodyBytes = 16 * 1024;
const maxGitHubReactionErrorBodyReadMilliseconds = 1000;
const maxGitHubReactionDiagnosticValueLength = 1024;
const maxGitHubReactionRedirects = 3;

export interface GitHubReactionErrorDiagnostics {
  readonly acceptedPermissions?: string | undefined;
  readonly bodyReadFailed?: boolean | undefined;
  readonly bodyReadTimedOut?: boolean | undefined;
  readonly documentationUrl?: string | undefined;
  readonly message?: string | undefined;
  readonly rateLimitRemaining?: string | undefined;
  readonly rateLimitReset?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfter?: string | undefined;
}

export interface GitHubReactionDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class GitHubReactionError extends Error {
  readonly diagnostics: GitHubReactionErrorDiagnostics;
  readonly retryDelaySeconds: number | undefined;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    rateLimited: boolean,
    diagnostics: GitHubReactionErrorDiagnostics = {},
    retryDelaySeconds?: number,
  ) {
    super(`GitHub reaction request returned ${status}.`);
    this.name = "GitHubReactionError";
    this.diagnostics = diagnostics;
    this.retryDelaySeconds = retryDelaySeconds;
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

  let url = new URL(`${resource}/issues/comments/${job.commentId}/reactions`);
  for (let redirects = 0; ; redirects += 1) {
    const response = await dependencies.fetch(url, {
      body: JSON.stringify({ content: reactionContent }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        "user-agent": githubUserAgent,
        "x-github-api-version": githubApiVersion,
      },
      method: "POST",
      redirect: "manual",
    });

    if (response.status === 200 || response.status === 201) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }

    const redirect =
      redirects < maxGitHubReactionRedirects ? reactionRedirectUrl(response, url) : undefined;
    if (redirect !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      url = redirect;
      continue;
    }

    const diagnostics = await readGitHubReactionErrorDiagnostics(response);

    throw new GitHubReactionError(
      response.status,
      response.status === 403 &&
        (response.headers.get("retry-after") !== null ||
          response.headers.get("x-ratelimit-remaining") === "0" ||
          diagnostics.bodyReadFailed === true ||
          diagnostics.bodyReadTimedOut === true ||
          /\bsecondary rate limit\b/iu.test(diagnostics.message ?? "")),
      diagnostics,
      retryDelayFromHeaders(response.headers),
    );
  }
}

function reactionRedirectUrl(response: Response, url: URL): URL | undefined {
  // GitHub redirects repeat the operation; Fetch would change POST to GET for 301/302.
  if (![301, 302, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  if (location === null) return undefined;
  let redirect: URL;
  try {
    redirect = new URL(location, url);
  } catch {
    return undefined;
  }
  return redirect.origin === githubApiBaseUrl &&
    redirect.username === "" &&
    redirect.password === ""
    ? redirect
    : undefined;
}

async function readGitHubReactionErrorDiagnostics(
  response: Response,
): Promise<GitHubReactionErrorDiagnostics> {
  const acceptedPermissions = boundedHeaderValue(response, "x-accepted-github-permissions");
  const rateLimitRemaining = boundedHeaderValue(response, "x-ratelimit-remaining");
  const rateLimitReset = boundedHeaderValue(response, "x-ratelimit-reset");
  const retryAfter = boundedHeaderValue(response, "retry-after");
  const requestId = boundedHeaderValue(response, "x-github-request-id");
  const headerDiagnostics = {
    ...(acceptedPermissions === undefined ? {} : { acceptedPermissions }),
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(rateLimitReset === undefined ? {} : { rateLimitReset }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(requestId === undefined ? {} : { requestId }),
  };

  let body: Awaited<ReturnType<typeof readBodyUpTo>>;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxGitHubReactionErrorBodyReadMilliseconds);
  try {
    body = await readBodyUpTo(response.body, maxGitHubReactionErrorBodyBytes, controller.signal);
  } catch {
    return controller.signal.aborted
      ? { ...headerDiagnostics, bodyReadTimedOut: true }
      : { ...headerDiagnostics, bodyReadFailed: true };
  } finally {
    clearTimeout(timeout);
  }

  if (!body.ok) {
    return { ...headerDiagnostics, bodyReadFailed: true };
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

function retryDelayFromHeaders(headers: Headers): number | undefined {
  const retryAfter = nonNegativeInteger(headers.get("retry-after"));
  const reset =
    headers.get("x-ratelimit-remaining") === "0"
      ? nonNegativeInteger(headers.get("x-ratelimit-reset"))
      : undefined;
  const resetDelay =
    reset === undefined ? undefined : Math.max(0, Math.ceil(reset - Date.now() / 1000));
  if (retryAfter === undefined && resetDelay === undefined) return undefined;
  return Math.min(24 * 60 * 60, Math.max(60, retryAfter ?? 0, resetDelay ?? 0));
}

function nonNegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
