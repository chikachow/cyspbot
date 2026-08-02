import { readBodyUpTo } from "@cyspbot/http/body";

export const githubAcceptHeader = "application/vnd.github+json";
export const githubApiVersion = "2022-11-28";
const maxGitHubErrorBodyBytes = 16 * 1024;

export interface GitHubApiEnv {
  GITHUB_API_BASE_URL?: string;
}

export interface GitHubApiDependencies {
  fetch: typeof fetch;
}

export const defaultGitHubApiDependencies: GitHubApiDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export class GitHubApiError extends Error {
  public readonly rateLimited: boolean;
  public readonly status: number;

  public constructor(status: number, message: string, rateLimited = false) {
    super(message);
    this.rateLimited = rateLimited;
    this.status = status;
  }
}

export class GitHubApiTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubApiTransportError";
  }
}

export async function fetchGitHubApiJson(
  env: GitHubApiEnv,
  path: string,
  headers: HeadersInit,
  dependencies: GitHubApiDependencies,
  init?: RequestInit,
): Promise<unknown> {
  const requestHeaders = new Headers(headers);

  for (const [name, value] of new Headers(init?.headers)) {
    requestHeaders.set(name, value);
  }

  const baseUrl = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const requestUrl = new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl));

  let response: Response;

  try {
    response = await dependencies.fetch(requestUrl, {
      ...init,
      headers: requestHeaders,
    });
  } catch {
    throw new GitHubApiTransportError(`GitHub API request failed: ${path}`);
  }

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `GitHub API request failed: ${path}`,
      await githubResponseIsRateLimited(response),
    );
  }

  let responseText: string;

  try {
    responseText = await response.text();
  } catch {
    throw new GitHubApiTransportError(`GitHub API request failed: ${path}`);
  }

  return JSON.parse(responseText) as unknown;
}

async function githubResponseIsRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  if (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  ) {
    return true;
  }

  let bodyRead: Awaited<ReturnType<typeof readBodyUpTo>>;

  try {
    bodyRead = await readBodyUpTo(response.body, maxGitHubErrorBodyBytes);
  } catch {
    return false;
  }

  if (!bodyRead.ok) {
    return false;
  }

  const body = new TextDecoder().decode(bodyRead.bytes);

  try {
    const parsed = JSON.parse(body) as unknown;

    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["message"] === "string" &&
      /\brate limit\b/iu.test((parsed as Record<string, string>)["message"] ?? "")
    );
  } catch {
    return false;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
