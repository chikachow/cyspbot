export const githubAcceptHeader = "application/vnd.github+json";
export const githubApiVersion = "2022-11-28";

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
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function fetchGitHubApi(
  env: GitHubApiEnv,
  path: string,
  headers: HeadersInit,
  dependencies: GitHubApiDependencies,
  init?: RequestInit,
): Promise<Response> {
  const requestHeaders = new Headers(headers);

  for (const [name, value] of new Headers(init?.headers)) {
    requestHeaders.set(name, value);
  }

  const baseUrl = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const requestUrl = new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl));

  const response = await dependencies.fetch(requestUrl, {
    ...init,
    headers: requestHeaders,
  });

  if (response.ok) {
    return response;
  }

  throw new GitHubApiError(response.status, `GitHub API request failed: ${path}`);
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
