import { importPKCS8, SignJWT } from "jose";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApiJson,
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

export interface InstallationAccessToken {
  expiresAt: string;
  permissions: Record<string, string>;
  token: string;
}

export class GitHubAppConfigurationError extends Error {
  public constructor() {
    super("invalid GitHub App configuration");
    this.name = "GitHubAppConfigurationError";
  }
}

export type GitHubAppEnv = GitHubApiEnv & {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: SecretTextBinding;
};

interface GitHubInstallationResponse {
  id: number;
}

interface GitHubInstallationAccessTokenResponse {
  expires_at: string;
  permissions?: Record<string, unknown>;
  token: string;
}

export async function resolveInstallationForRepository(
  env: GitHubAppEnv,
  repository: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<ResolvedGitHubAppInstallation> {
  const body = (await fetchGitHubApiJson(
    env,
    `/repos/${repository}/installation`,
    await appAuthenticationHeaders(env),
    dependencies,
  )) as GitHubInstallationResponse;

  if (typeof body.id !== "number") {
    throw new GitHubApiError(502, "invalid installation response");
  }

  return { id: body.id };
}

export async function createInstallationAccessTokenForRepositoryName(
  env: GitHubAppEnv,
  installationId: number,
  repositoryName: string,
  permissions: Record<string, string>,
  dependencies: GitHubApiDependencies,
): Promise<InstallationAccessToken> {
  const requestBody = {
    permissions,
    repositories: [repositoryName],
  };

  const responseBody = (await fetchGitHubApiJson(
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
  )) as GitHubInstallationAccessTokenResponse;

  if (
    typeof responseBody.token !== "string" ||
    typeof responseBody.expires_at !== "string" ||
    !isStringRecord(responseBody.permissions)
  ) {
    throw new GitHubApiError(502, "invalid installation access token response");
  }

  return {
    expiresAt: responseBody.expires_at,
    permissions: responseBody.permissions,
    token: responseBody.token,
  };
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
    throw new GitHubAppConfigurationError();
  });
  cachedPrivateKey = { fingerprint, imported };

  return imported;
}

async function githubAppPrivateKeyPem(env: GitHubAppEnv): Promise<string> {
  const privateKeyPem = await resolveSecretText(env.GITHUB_APP_PRIVATE_KEY);

  if (privateKeyPem !== undefined && privateKeyPem.length > 0) {
    return privateKeyPem;
  }

  throw new GitHubAppConfigurationError();
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
