import { githubActionsIssuerAdapter } from "@cyspbot/github-actions-oidc/issuer";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";

export const configuredOidcIssuerAdapters: readonly OidcIssuerAdapter<GitHubActionsPrincipal>[] = [
  githubActionsIssuerAdapter,
];
