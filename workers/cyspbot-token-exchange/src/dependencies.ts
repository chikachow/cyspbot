import type { InstallationTokenIssuanceDependencies } from "./policy/installation-token-issuance.ts";
import { authenticateOidcToken as defaultAuthenticateOidcToken } from "./authentication.ts";
import { configuredOidcIssuerAdapters } from "./oidc-issuers.ts";

export interface TokenExchangeDependencies extends InstallationTokenIssuanceDependencies {
  authenticateOidcToken: typeof defaultAuthenticateOidcToken;
  now(): Date;
}

export const defaultTokenExchangeDependencies: TokenExchangeDependencies = {
  authenticateOidcToken: (token, request, expectedAudience, issuerAdapters, fetchJwks) =>
    defaultAuthenticateOidcToken(token, request, expectedAudience, issuerAdapters, fetchJwks),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

export { configuredOidcIssuerAdapters };
