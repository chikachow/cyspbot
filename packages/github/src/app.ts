import { importPKCS8, SignJWT } from "jose";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApi,
  GitHubApiError,
  githubAcceptHeader,
  githubApiVersion,
  type GitHubApiDependencies,
  type GitHubApiEnv,
} from "./http.ts";
import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";

const githubJwtLifetimeSeconds = 9 * 60;
const githubStatelessS2STokenHeader = "X-GitHub-Stateless-S2S-Token";

let cachedPrivateKey:
  | {
      readonly fingerprint: string;
      readonly imported: Promise<CryptoKey>;
    }
  | undefined;

export interface ResolvedGitHubAppInstallation {
  id: number;
}

export interface InstallationToken {
  expiresAt: string;
  permissions: Record<string, string>;
  token: string;
}

export type GitHubAppEnv = GitHubApiEnv & {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: SecretTextBinding;
};

interface GitHubInstallationResponse {
  id: number;
}

interface GitHubInstallationTokenResponse {
  expires_at: string;
  permissions?: Record<string, unknown>;
  token: string;
}

export async function resolveInstallationForRepository(
  env: GitHubAppEnv,
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

export async function createInstallationTokenForRepository(
  env: GitHubAppEnv,
  installationId: number,
  repository: string,
  permissions: Record<string, string> | undefined,
  dependencies: GitHubApiDependencies,
): Promise<InstallationToken> {
  const repositoryName = parseRepositoryName(repository);

  if (repositoryName === null) {
    throw new GitHubApiError(400, "invalid repository");
  }

  const requestBody: {
    permissions?: Record<string, string>;
    repositories: string[];
  } = {
    repositories: [repositoryName],
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

function parseRepositoryName(repository: string): string | null {
  const parts = repository.split("/");

  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return null;
  }

  return parts[1] ?? null;
}

async function appAuthenticationHeaders(env: GitHubAppEnv): Promise<HeadersInit> {
  const jwt = await createGitHubAppJwt(env);

  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${jwt}`,
    "user-agent": "cyspbot",
    "x-github-api-version": githubApiVersion,
  };
}

async function createGitHubAppJwt(env: GitHubAppEnv): Promise<string> {
  const privateKey = await importedGitHubAppPrivateKey(await githubAppPrivateKeyPem(env));
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + githubJwtLifetimeSeconds)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(privateKey);
}

async function importedGitHubAppPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const fingerprint = await privateKeyFingerprint(privateKeyPem);
  const cached = cachedPrivateKey;

  if (cached?.fingerprint === fingerprint) {
    return cached.imported;
  }

  const imported = importPKCS8(privateKeyPem, "RS256").catch(() => {
    throw new GitHubApiError(500, "invalid GitHub App private key");
  });
  cachedPrivateKey = { fingerprint, imported };

  return imported;
}

async function githubAppPrivateKeyPem(env: GitHubAppEnv): Promise<string> {
  const privateKeyPem = await resolveSecretText(env.GITHUB_APP_PRIVATE_KEY);

  if (privateKeyPem !== undefined && privateKeyPem.length > 0) {
    return privateKeyPem;
  }

  throw new GitHubApiError(500, "missing GitHub App private key");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

async function privateKeyFingerprint(privateKeyPem: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateKeyPem));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
