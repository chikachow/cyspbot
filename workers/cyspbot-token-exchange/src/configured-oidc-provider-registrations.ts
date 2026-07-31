import { githubActionsOidcProviderRegistration } from "@cyspbot/oidc-provider-github-actions";
import { googleServiceAccountOidcProviderRegistration } from "@cyspbot/oidc-provider-google-service-account";

export { githubActionsOidcProviderRegistration, googleServiceAccountOidcProviderRegistration };

export const configuredOidcProviderRegistrations = Object.freeze([
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
]);
