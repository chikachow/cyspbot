import {
  type InstallationTokenIssuanceResult,
  issueInstallationTokenForContext,
} from "./policy/installation-token-issuance.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  type AuthenticateRequestResult,
  type AuthenticatedContext,
  type SubjectTokenType,
  cyspbotOidcAudience,
} from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "./installation-token-request.ts";
import { configuredOidcIssuerAdapters } from "./oidc-issuers.ts";
import type { TokenPolicy } from "./policy/token-policy.ts";
import { tokenPolicyRules } from "./policy/token-policy-rules.ts";
import type { TokenExchangeApplication } from "./token-exchange-application.ts";

export interface TokenExchangeRequestRuntime {
  authenticateSubjectToken(input: {
    request: Request;
    subjectToken: string;
    subjectTokenType: SubjectTokenType;
  }): Promise<AuthenticateRequestResult>;
  issueInstallationToken(
    context: AuthenticatedContext,
    tokenRequest: InstallationAccessTokenRequest,
  ): Promise<InstallationTokenIssuanceResult>;
  now(): Date;
  rateLimit(key: string): Promise<boolean>;
}

export interface TokenExchangeWorkerDependencies {
  fetch: typeof fetch;
  fetchJwks?: typeof fetch;
  now(): Date;
  tokenPolicy: TokenPolicy;
}

export const defaultTokenExchangeWorkerDependencies: TokenExchangeWorkerDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  tokenPolicy: tokenPolicyRules,
};

export function createTokenExchangeRequestRuntime(
  env: TokenExchangeEnv,
  dependencies: TokenExchangeWorkerDependencies,
): TokenExchangeRequestRuntime {
  const application = tokenExchangeApplication(env, dependencies.tokenPolicy);

  return {
    authenticateSubjectToken: ({ request, subjectToken, subjectTokenType }) =>
      defaultAuthenticateOidcToken(
        subjectToken,
        subjectTokenType,
        request,
        cyspbotOidcAudience,
        configuredOidcIssuerAdapters(env),
        dependencies.fetchJwks,
      ),
    issueInstallationToken: (context, tokenRequest) =>
      issueInstallationTokenForContext(application, context, tokenRequest, dependencies),
    now: () => dependencies.now(),
    rateLimit: async (key) => {
      const result = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({ key });

      return result.success;
    },
  };
}

function tokenExchangeApplication(
  env: TokenExchangeEnv,
  tokenPolicy: TokenPolicy,
): TokenExchangeApplication {
  return {
    githubApp: {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL }),
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    },
    tokenPolicy,
  };
}
