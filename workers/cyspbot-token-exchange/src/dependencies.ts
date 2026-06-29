import type { InstallationTokenIssuanceDependencies } from "./policy/installation-token-issuance.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  type AuthenticateRequestResult,
} from "./authentication.ts";
import type { ParsedGitHubAppAudience } from "./policy/github-app-audience.ts";

export interface TokenExchangeDependencies extends InstallationTokenIssuanceDependencies {
  authenticateOidcToken(
    token: string,
    request: Request,
    expectedAudience: ParsedGitHubAppAudience,
  ): Promise<AuthenticateRequestResult>;
  now(): Date;
}

export const defaultTokenExchangeDependencies: TokenExchangeDependencies = {
  authenticateOidcToken: defaultAuthenticateOidcToken,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};
