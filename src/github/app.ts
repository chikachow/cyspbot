import { importPKCS8, SignJWT } from "jose";

import type { Env } from "../env.ts";
import type { TokenPolicyRepository } from "../policy/token-policy.ts";
import {
  defaultGitHubApiDependencies,
  fetchGitHubApi,
  GitHubApiError,
  githubAcceptHeader,
  githubApiVersion,
  type GitHubApiDependencies,
} from "./http.ts";

const githubJwtLifetimeSeconds = 9 * 60;
const githubStatelessS2STokenHeader = "X-GitHub-Stateless-S2S-Token";
const privateKeysByPem = new Map<string, Promise<CryptoKey>>();

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

export async function createInstallationToken(
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

export async function getRepository(
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

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
