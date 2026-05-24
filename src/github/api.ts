import { importPKCS8, SignJWT } from "jose";

import type { Env } from "../env.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
import {
  evaluateTokenPolicy,
  type TokenPolicyAllowDecision,
  type TokenPolicyDecision,
  type TokenPolicyRepository,
} from "../policy/token-policy.ts";

const githubAcceptHeader = "application/vnd.github+json";
const githubApiVersion = "2022-11-28";
const githubJwtLifetimeSeconds = 9 * 60;
const githubStatelessS2STokenHeader = "X-GitHub-Stateless-S2S-Token";
const privateKeysByPem = new Map<string, Promise<CryptoKey>>();
const dashboardPageSize = 100;

export interface GitHubApiDependencies {
  fetch: typeof fetch;
}

const defaultGitHubApiDependencies: GitHubApiDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export class TokenPolicyDeniedError extends Error {
  public readonly policyDecision?: TokenPolicyDecision;
  public readonly repository?: GitHubRepository;

  public constructor(
    message: string,
    policyDecision?: TokenPolicyDecision,
    repository?: GitHubRepository,
  ) {
    super(message);
    this.policyDecision = policyDecision;
    this.repository = repository;
  }
}

export class GitHubApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ResolvedGitHubAppInstallation {
  id: number;
}

export interface InstallationToken {
  expiresAt: string;
  permissions: Record<string, string>;
  token: string;
}

export interface GitHubRepository extends TokenPolicyRepository {
  defaultBranchRef: string;
}

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

interface GitHubRepositoryApiResponse {
  default_branch: string;
  id?: number;
  owner?: {
    id?: number;
  };
  visibility?: unknown;
}

interface GitHubInstallationResponse {
  id: number;
}

interface GitHubInstallationTokenResponse {
  expires_at: string;
  permissions?: Record<string, unknown>;
  token: string;
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

export async function resolveInstallationForRepository(
  env: Env,
  repository: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<ResolvedGitHubAppInstallation> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}/installation`,
    await appAuthenticationHeaders(env),
    dependencies,
  );

  const body = (await response.json()) as GitHubInstallationResponse;

  if (typeof body.id !== "number") {
    throw new GitHubApiError(502, "invalid installation response");
  }

  return { id: body.id };
}

export async function authorizeInstallationTokenIssuance(
  env: Env,
  installationId: number,
  caller: GitHubActionsPrincipal,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<{ policyDecision: TokenPolicyAllowDecision; repository: GitHubRepository }> {
  const metadataToken = await createRepositoryMetadataToken(
    env,
    installationId,
    caller.repositoryId,
    dependencies,
  );
  const repository = await getRepository(env, caller.repository, metadataToken.token, dependencies);
  const policyDecision = evaluateTokenPolicy(caller, repository);

  if (policyDecision.decision !== "allow") {
    throw new TokenPolicyDeniedError(
      "Token Policy denied Installation Token Issuance",
      policyDecision,
      repository,
    );
  }

  return { policyDecision, repository };
}

export async function createRepositoryScopedInstallationToken(
  env: Env,
  installationId: number,
  repositoryId: string,
  permissions: Record<string, string>,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<InstallationToken> {
  return createInstallationToken(env, installationId, repositoryId, permissions, dependencies);
}

async function createRepositoryMetadataToken(
  env: Env,
  installationId: number,
  repositoryId: string,
  dependencies: GitHubApiDependencies,
): Promise<InstallationToken> {
  return createInstallationToken(
    env,
    installationId,
    repositoryId,
    { metadata: "read" },
    dependencies,
  );
}

async function createInstallationToken(
  env: Env,
  installationId: number,
  repositoryId: string,
  permissions: Record<string, string> | undefined,
  dependencies: GitHubApiDependencies,
): Promise<InstallationToken> {
  const parsedRepositoryId = Number.parseInt(repositoryId, 10);

  if (!Number.isSafeInteger(parsedRepositoryId)) {
    throw new GitHubApiError(400, "invalid repository id");
  }

  const requestBody: { permissions?: Record<string, string>; repository_ids: number[] } = {
    repository_ids: [parsedRepositoryId],
  };

  if (permissions !== undefined) {
    requestBody.permissions = permissions;
  }

  const response = await fetchGitHubApi(
    env,
    `/app/installations/${installationId}/access_tokens`,
    await appAuthenticationHeaders(env),
    dependencies,
    {
      body: JSON.stringify(requestBody),
      headers: {
        "content-type": "application/json",
        [githubStatelessS2STokenHeader]: "enabled",
      },
      method: "POST",
    },
  );

  const responseBody = (await response.json()) as GitHubInstallationTokenResponse;

  if (
    typeof responseBody.token !== "string" ||
    typeof responseBody.expires_at !== "string" ||
    !isStringRecord(responseBody.permissions)
  ) {
    throw new GitHubApiError(502, "invalid installation token response");
  }

  return {
    expiresAt: responseBody.expires_at,
    permissions: responseBody.permissions,
    token: responseBody.token,
  };
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

async function getRepository(
  env: Env,
  repository: string,
  installationToken: string,
  dependencies: GitHubApiDependencies,
): Promise<GitHubRepository> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}`,
    installationAuthenticationHeaders(installationToken),
    dependencies,
  );

  const body = (await response.json()) as GitHubRepositoryApiResponse;
  const defaultBranch = body.default_branch;
  const repositoryId = body.id;
  const ownerId = body.owner?.id;
  const visibility = body.visibility;

  if (
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0 ||
    typeof repositoryId !== "number" ||
    typeof ownerId !== "number" ||
    typeof visibility !== "string" ||
    visibility.length === 0
  ) {
    throw new GitHubApiError(502, "invalid repository response");
  }

  return {
    defaultBranch,
    defaultBranchRef: `refs/heads/${defaultBranch}`,
    repository,
    repositoryId: String(repositoryId),
    repositoryOwnerId: String(ownerId),
    repositoryVisibility: visibility,
  };
}

async function appAuthenticationHeaders(env: Env): Promise<HeadersInit> {
  const jwt = await createGitHubAppJwt(env);

  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${jwt}`,
    "user-agent": "cyspbot",
    "x-github-api-version": githubApiVersion,
  };
}

function installationAuthenticationHeaders(token: string): HeadersInit {
  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${token}`,
    "user-agent": "cyspbot",
    "x-github-api-version": githubApiVersion,
  };
}

async function createGitHubAppJwt(env: Env): Promise<string> {
  const privateKey = await importedGitHubAppPrivateKey(await githubAppPrivateKeyPem(env));
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + githubJwtLifetimeSeconds)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(privateKey);
}

function importedGitHubAppPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const cached = privateKeysByPem.get(privateKeyPem);

  if (cached !== undefined) {
    return cached;
  }

  const imported = importPKCS8(privateKeyPem, "RS256").catch((error: unknown) => {
    throw new GitHubApiError(
      500,
      `invalid GitHub App private key: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  privateKeysByPem.set(privateKeyPem, imported);

  return imported;
}

async function githubAppPrivateKeyPem(env: Env): Promise<string> {
  let secretStoreKey: string | null | undefined;

  try {
    secretStoreKey = await env.GITHUB_APP_PRIVATE_KEY?.get();
  } catch {
    secretStoreKey = undefined;
  }

  if (secretStoreKey !== null && secretStoreKey !== undefined && secretStoreKey.length > 0) {
    return secretStoreKey;
  }

  const localKey = env.GITHUB_APP_PRIVATE_KEY_PEM;

  if (localKey !== undefined && localKey.length > 0) {
    return localKey;
  }

  throw new GitHubApiError(500, "missing GitHub App private key");
}

async function fetchGitHubOAuthToken(
  env: Env,
  params: Record<string, string>,
  dependencies: GitHubApiDependencies,
): Promise<GitHubOauthAccessTokenResponse> {
  const path = "/login/oauth/access_token";
  const requestHeaders = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "cyspbot",
  };
  const body = new URLSearchParams(params).toString();
  const baseUrl = env.GITHUB_WEB_BASE_URL ?? "https://github.com";
  const response = await dependencies.fetch(
    new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl)),
    {
      body,
      headers: requestHeaders,
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new GitHubApiError(response.status, "GitHub OAuth token request failed");
  }

  return (await response.json()) as GitHubOauthAccessTokenResponse;
}

async function fetchGitHubApi(
  env: Env,
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

  const responseText = await response.text().catch(() => "");
  const responseDetail = responseText.length > 0 ? `: ${responseText.slice(0, 1000)}` : "";

  throw new GitHubApiError(response.status, `GitHub API request failed: ${path}${responseDetail}`);
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
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
