import type { GitHubInstallationObject } from "./durable-objects/installation-object.ts";
import type { OidcIssuerVerifierObject } from "./durable-objects/oidc-issuer-verifier-object.ts";

export interface SecretsStoreSecretBinding {
  get(): Promise<string | null>;
}

export interface Env {
  AUDIT_LOG_MAX_ENTRIES?: string;
  AUDIT_LOG_RETENTION_DAYS?: string;
  DASHBOARD_ACCESS_CACHE_TTL_SECONDS?: string;
  DASHBOARD_SESSION_LOOKUP_SECRET?: string;
  DASHBOARD_TOKEN_ENCRYPTION_SECRET?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: SecretsStoreSecretBinding;
  GITHUB_APP_PRIVATE_KEY_PEM?: string;
  GITHUB_WEB_BASE_URL?: string;
  DB: D1Database;
  GITHUB_INSTALLATION: DurableObjectNamespace<GitHubInstallationObject>;
  GITHUB_WEBHOOK_SECRET?: string;
  OIDC_ISSUER_VERIFIER: DurableObjectNamespace<OidcIssuerVerifierObject>;
}
