import { githubActionsIssuerAdapter } from "@cyspbot/oidc-issuer-github-actions";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

export const configuredOidcIssuerAdapters: readonly OidcIssuerAdapter[] = [
  githubActionsIssuerAdapter,
];
