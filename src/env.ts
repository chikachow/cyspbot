import type { GitHubInstallationObject } from "./durable-objects/installation-object.ts";
import type { OidcIssuerVerifierObject } from "./durable-objects/oidc-issuer-verifier-object.ts";

export interface SecretsStoreSecretBinding {
  get(): Promise<string | null>;
}

export interface Env {
  AUDIT_LOG_MAX_ENTRIES?: string;
  AUDIT_LOG_RETENTION_DAYS?: string;
  ENABLE_TEST_GITHUB_API?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY?: SecretsStoreSecretBinding;
  GITHUB_APP_PRIVATE_KEY_PEM?: string;
  GITHUB_INSTALLATION: DurableObjectNamespace<GitHubInstallationObject>;
  GITHUB_WEBHOOK_SECRET?: string;
  MAINTENANCE_API_TOKEN?: string;
  OIDC_ISSUER_VERIFIER: DurableObjectNamespace<OidcIssuerVerifierObject>;
  TEST_OIDC_JWKS_CACHE_CONTROL?: string;
  TEST_OIDC_JWKS_JSON?: string;
  TEST_OIDC_JWKS_URI?: string;
  TEST_GITHUB_DEFAULT_BRANCH?: string;
  TEST_GITHUB_INSTALLATION_ID?: string;
  TEST_GITHUB_MINTED_TOKEN?: string;
  TEST_GITHUB_REPOSITORY_OWNER_ID?: string;
  TEST_GITHUB_REPOSITORY?: string;
  TEST_GITHUB_REPOSITORY_ID?: string;
  TEST_GITHUB_REPOSITORY_VISIBILITY?: string;
}
