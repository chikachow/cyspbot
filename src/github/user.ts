import type { Env } from "../env.ts";
import {
  defaultGitHubApiDependencies,
  fetchGitHubApi,
  fetchGitHubWeb,
  GitHubApiError,
  githubAcceptHeader,
  githubApiVersion,
  type GitHubApiDependencies,
} from "./http.ts";

const dashboardPageSize = 100;

export interface GitHubAuthenticatedUser {
  id: string;
  login: string;
}

export interface GitHubUserAccessToken {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
}

export interface GitHubUserInstallation {
  id: number;
}

export interface GitHubUserRepositoryAccess {
  archived: boolean;
  fullName: string;
  githubRepoId: string;
  installationId: number;
  private: boolean;
}

interface GitHubOauthAccessTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
}

interface GitHubUserApiResponse {
  id?: number;
  login?: string;
}

interface GitHubUserInstallationApiResponse {
  id?: number;
}

interface GitHubUserInstallationsResponse {
  installations?: GitHubUserInstallationApiResponse[];
}

interface GitHubUserRepositoryAccessApiResponse {
  archived?: unknown;
  full_name?: unknown;
  id?: number;
  private?: unknown;
}

interface GitHubUserInstallationRepositoriesResponse {
  repositories?: GitHubUserRepositoryAccessApiResponse[];
}

export async function exchangeGitHubUserCode(
  env: Env,
  code: string,
  redirectUri: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubUserAccessToken> {
  const response = await fetchGitHubOAuthToken(
    env,
    {
      client_id: requireGitHubAppClientId(env),
      client_secret: requireGitHubAppClientSecret(env),
      code,
      redirect_uri: redirectUri,
    },
    dependencies,
  );

  return parseGitHubUserAccessTokenResponse(response);
}

export async function getAuthenticatedGitHubUser(
  env: Env,
  accessToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubAuthenticatedUser> {
  const response = await fetchGitHubApi(
    env,
    "/user",
    userAuthenticationHeaders(accessToken),
    dependencies,
  );
  const body = (await response.json()) as GitHubUserApiResponse;

  if (typeof body.id !== "number" || typeof body.login !== "string" || body.login.length === 0) {
    throw new GitHubApiError(502, "invalid authenticated user response");
  }

  return {
    id: String(body.id),
    login: body.login,
  };
}

export async function listGitHubUserInstallations(
  env: Env,
  accessToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubUserInstallation[]> {
  const installations: GitHubUserInstallation[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetchGitHubApi(
      env,
      `/user/installations?per_page=${dashboardPageSize}&page=${page}`,
      userAuthenticationHeaders(accessToken),
      dependencies,
    );
    const body = (await response.json()) as GitHubUserInstallationsResponse;
    const pageInstallations = body.installations;

    if (!Array.isArray(pageInstallations)) {
      throw new GitHubApiError(502, "invalid user installations response");
    }

    for (const installation of pageInstallations) {
      if (typeof installation.id === "number") {
        installations.push({ id: installation.id });
      }
    }

    if (pageInstallations.length < dashboardPageSize) {
      return installations;
    }
  }
}

export async function listGitHubUserInstallationRepositories(
  env: Env,
  accessToken: string,
  installationId: number,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubUserRepositoryAccess[]> {
  const repositories: GitHubUserRepositoryAccess[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetchGitHubApi(
      env,
      `/user/installations/${installationId}/repositories?per_page=${dashboardPageSize}&page=${page}`,
      userAuthenticationHeaders(accessToken),
      dependencies,
    );
    const body = (await response.json()) as GitHubUserInstallationRepositoriesResponse;
    const pageRepositories = body.repositories;

    if (!Array.isArray(pageRepositories)) {
      throw new GitHubApiError(502, "invalid user installation repositories response");
    }

    for (const repository of pageRepositories) {
      if (
        typeof repository.id === "number" &&
        typeof repository.full_name === "string" &&
        typeof repository.private === "boolean"
      ) {
        repositories.push({
          archived: repository.archived === true,
          fullName: repository.full_name,
          githubRepoId: String(repository.id),
          installationId,
          private: repository.private,
        });
      }
    }

    if (pageRepositories.length < dashboardPageSize) {
      return repositories;
    }
  }
}

export async function refreshGitHubUserAccessToken(
  env: Env,
  refreshToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubUserAccessToken> {
  const response = await fetchGitHubOAuthToken(
    env,
    {
      client_id: requireGitHubAppClientId(env),
      client_secret: requireGitHubAppClientSecret(env),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    dependencies,
  );

  return parseGitHubUserAccessTokenResponse(response);
}

async function fetchGitHubOAuthToken(
  env: Env,
  params: Record<string, string>,
  dependencies: GitHubApiDependencies,
): Promise<GitHubOauthAccessTokenResponse> {
  const response = await fetchGitHubWeb(env, "/login/oauth/access_token", dependencies, {
    body: new URLSearchParams(params).toString(),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "cyspbot",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new GitHubApiError(response.status, "GitHub OAuth token request failed");
  }

  return (await response.json()) as GitHubOauthAccessTokenResponse;
}

function parseGitHubUserAccessTokenResponse(
  body: GitHubOauthAccessTokenResponse,
): GitHubUserAccessToken {
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new GitHubApiError(502, "invalid GitHub OAuth token response");
  }

  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: expiresAtFromLifetime(body.expires_in),
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    refreshTokenExpiresAt: expiresAtFromLifetime(body.refresh_token_expires_in),
  };
}

function requireGitHubAppClientId(env: Env): string {
  if (env.GITHUB_APP_CLIENT_ID === undefined || env.GITHUB_APP_CLIENT_ID.length === 0) {
    throw new GitHubApiError(500, "missing GitHub App client id");
  }

  return env.GITHUB_APP_CLIENT_ID;
}

function requireGitHubAppClientSecret(env: Env): string {
  if (env.GITHUB_APP_CLIENT_SECRET === undefined || env.GITHUB_APP_CLIENT_SECRET.length === 0) {
    throw new GitHubApiError(500, "missing GitHub App client secret");
  }

  return env.GITHUB_APP_CLIENT_SECRET;
}

function expiresAtFromLifetime(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(Date.now() + value * 1000).toISOString();
}

function userAuthenticationHeaders(accessToken: string): HeadersInit {
  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${accessToken}`,
    "user-agent": "cyspbot",
    "x-github-api-version": githubApiVersion,
  };
}
