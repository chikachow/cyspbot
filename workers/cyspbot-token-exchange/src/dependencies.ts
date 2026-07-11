import {
  type InstallationTokenIssuanceDependencies,
  type InstallationTokenIssuanceResult,
  issueInstallationTokenForContext,
} from "./policy/installation-token-issuance.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  type AuthenticateRequestResult,
  type AuthenticatedContext,
  cyspbotOidcAudience,
} from "./authentication.ts";
import { configuredOidcIssuerAdapters } from "./oidc-issuers.ts";
import type { InstallationAccessTokenRequest } from "./policy/token-policy.ts";

export interface TokenExchangeRequestRuntime {
  authenticateSubjectToken(input: {
    request: Request;
    subjectToken: string;
  }): Promise<AuthenticateRequestResult>;
  issueInstallationToken(
    context: AuthenticatedContext,
    tokenRequest: InstallationAccessTokenRequest,
  ): Promise<InstallationTokenIssuanceResult>;
  now(): Date;
  rateLimit(key: string): Promise<boolean>;
}

export interface TokenExchangeWorkerDependencies extends InstallationTokenIssuanceDependencies {
  fetchJwks?: typeof fetch;
  now(): Date;
}

export const defaultTokenExchangeWorkerDependencies: TokenExchangeWorkerDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

export function createTokenExchangeRequestRuntime(
  env: TokenExchangeBindings,
  dependencies: TokenExchangeWorkerDependencies,
): TokenExchangeRequestRuntime {
  return {
    authenticateSubjectToken: ({ request, subjectToken }) =>
      defaultAuthenticateOidcToken(
        subjectToken,
        request,
        cyspbotOidcAudience,
        configuredOidcIssuerAdapters,
        dependencies.fetchJwks,
      ),
    issueInstallationToken: (context, tokenRequest) =>
      issueInstallationTokenForContext(env, context, tokenRequest, dependencies),
    now: () => dependencies.now(),
    rateLimit: async (key) => {
      const result = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({ key });

      return result.success;
    },
  };
}
