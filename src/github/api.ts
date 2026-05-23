import { importPKCS8, SignJWT } from "jose";

import type { Env } from "../env.ts";
import type { GitHubActionsPrincipal } from "../oidc/principals.ts";
import {
  evaluateTokenMintPolicy,
  type TokenMintAuthorizationRepository,
  type TokenMintPolicyDecision,
} from "../policy/token-mint-authorization.ts";
import { maybeMockGitHubApiResponse } from "./test-api.ts";

const githubAcceptHeader = "application/vnd.github+json";
const githubApiVersion = "2022-11-28";
const githubJwtLifetimeSeconds = 9 * 60;
const githubStatelessS2STokenHeader = "X-GitHub-Stateless-S2S-Token";
const privateKeysByPem = new Map<string, Promise<CryptoKey>>();

export class BrokerAuthorizationError extends Error {
  public readonly policyDecision?: TokenMintPolicyDecision;
  public readonly repository?: GitHubRepository;

  public constructor(
    message: string,
    policyDecision?: TokenMintPolicyDecision,
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

export interface InstallationLookup {
  id: number;
}

export interface InstallationToken {
  expiresAt: string;
  permissions: Record<string, string>;
  token: string;
}

export interface GitHubRepository extends TokenMintAuthorizationRepository {
  defaultBranchRef: string;
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

export async function resolveInstallationForRepository(
  env: Env,
  repository: string,
): Promise<InstallationLookup> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}/installation`,
    await appAuthenticationHeaders(env),
  );

  const body = (await response.json()) as GitHubInstallationResponse;

  if (typeof body.id !== "number") {
    throw new GitHubApiError(502, "invalid installation response");
  }

  return { id: body.id };
}

export async function authorizeTokenMintRequest(
  env: Env,
  caller: GitHubActionsPrincipal,
): Promise<{ policyDecision: TokenMintPolicyDecision; repository: GitHubRepository }> {
  const repository = await getRepository(env, caller.repository);
  const policyDecision = evaluateTokenMintPolicy(caller, repository);

  if (policyDecision.decision !== "allow") {
    throw new BrokerAuthorizationError(
      "token mint policy denied request",
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
): Promise<InstallationToken> {
  const parsedRepositoryId = Number.parseInt(repositoryId, 10);

  if (!Number.isSafeInteger(parsedRepositoryId)) {
    throw new GitHubApiError(400, "invalid repository id");
  }

  const response = await fetchGitHubApi(
    env,
    `/app/installations/${installationId}/access_tokens`,
    await appAuthenticationHeaders(env),
    {
      body: JSON.stringify({
        repository_ids: [parsedRepositoryId],
      }),
      headers: {
        [githubStatelessS2STokenHeader]: "enabled",
      },
      method: "POST",
    },
  );

  const body = (await response.json()) as GitHubInstallationTokenResponse;

  if (
    typeof body.token !== "string" ||
    typeof body.expires_at !== "string" ||
    !isStringRecord(body.permissions)
  ) {
    throw new GitHubApiError(502, "invalid installation token response");
  }

  return {
    expiresAt: body.expires_at,
    permissions: body.permissions,
    token: body.token,
  };
}

async function getRepository(env: Env, repository: string): Promise<GitHubRepository> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}`,
    await appAuthenticationHeaders(env),
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

async function fetchGitHubApi(
  env: Env,
  path: string,
  headers: HeadersInit,
  init?: RequestInit,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  const method = init?.method ?? "GET";

  for (const [name, value] of new Headers(init?.headers)) {
    requestHeaders.set(name, value);
  }

  const mockResponse = maybeMockGitHubApiResponse(
    env,
    normalizeGitHubApiPath(path),
    method,
    requestHeaders,
    typeof init?.body === "string" ? init.body : undefined,
  );

  if (mockResponse !== null) {
    if (mockResponse.ok) {
      return mockResponse;
    }

    throw new GitHubApiError(mockResponse.status, `GitHub API request failed: ${path}`);
  }

  const baseUrl = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const requestUrl = new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl));

  const response = await fetch(requestUrl, {
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

function normalizeGitHubApiPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
