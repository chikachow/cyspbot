import type { GitHubInstallationObject } from "./durable-objects/installation-object.ts";

export interface SecretsStoreSecretBinding {
  get(): Promise<string | null>;
}

export interface Env {
  AUDIT_LOG_MAX_ENTRIES?: string;
  AUDIT_LOG_RETENTION_DAYS?: string;
  ENABLE_TEST_GITHUB_API?: string;
  GITHUB_ACTIONS_OIDC_AUDIENCE: string;
  GITHUB_ACTIONS_OIDC_ISSUER?: string;
  GITHUB_ACTIONS_OIDC_JWKS_URL?: string;
  GITHUB_ACTIONS_OIDC_PUBLIC_KEY_PEM_BASE64?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY?: SecretsStoreSecretBinding;
  GITHUB_APP_PRIVATE_KEY_PEM?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_INSTALLATION: DurableObjectNamespace<GitHubInstallationObject>;
  TEST_GITHUB_DEFAULT_BRANCH?: string;
  TEST_GITHUB_INSTALLATION_ID?: string;
  TEST_GITHUB_MINTED_TOKEN?: string;
  TEST_GITHUB_REPOSITORY?: string;
  TEST_GITHUB_REPOSITORY_ID?: string;
}
