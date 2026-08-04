import {
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
} from "@cyspbot/oidc-providers";

export { githubActionsOidcProviderRegistration, googleServiceAccountOidcProviderRegistration };

export const configuredOidcProviderRegistrations = Object.freeze([
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
]);
