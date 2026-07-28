import {
  type InstallationAccessTokenIssuanceResult,
  issueInstallationAccessTokenForContext,
} from "./policy/installation-access-token-issuance.ts";
import {
  authenticateOidcIdToken,
  type AuthenticateRequestResult,
  type AuthenticatedContext,
} from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "./installation-access-token-request.ts";
import { createOidcIdTokenAuthenticatorResolver } from "./oidc-authentication.ts";
import type { TokenPolicy } from "./policy/token-policy.ts";
import { tokenPolicyRules } from "./policy/token-policy-rules.ts";
import type { TokenExchangeApplication } from "./token-exchange-application.ts";
import type { OidcIdTokenAuthenticatorDependencies } from "@cyspbot/oidc/id-token-authenticator";

export interface TokenExchangeRequestRuntime {
  authenticateIdToken(input: {
    request: Request;
    subjectToken: string;
  }): Promise<AuthenticateRequestResult>;
  issueInstallationAccessToken(
    context: AuthenticatedContext,
    tokenRequest: InstallationAccessTokenRequest,
  ): Promise<InstallationAccessTokenIssuanceResult>;
  now(): Date;
  rateLimit(key: string): Promise<boolean>;
}

export interface TokenExchangeWorkerDependencies {
  fetch: typeof fetch;
  now(): Date;
  tokenPolicy: TokenPolicy;
}

export const defaultTokenExchangeWorkerDependencies: TokenExchangeWorkerDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  tokenPolicy: tokenPolicyRules,
};

export function createTokenExchangeRequestRuntimeFactory(
  dependencies: TokenExchangeWorkerDependencies,
): (env: TokenExchangeEnv) => TokenExchangeRequestRuntime {
  const oidcIdTokenAuthenticatorDependencies: OidcIdTokenAuthenticatorDependencies = {
    fetch: (input, init) => dependencies.fetch(input, init),
    now: () => dependencies.now(),
    observe: (event) => console.warn(event),
  };
  const resolveOidcIdTokenAuthenticator = createOidcIdTokenAuthenticatorResolver(
    oidcIdTokenAuthenticatorDependencies,
    dependencies.tokenPolicy,
  );

  return (env) => {
    const application = tokenExchangeApplication(env, dependencies.tokenPolicy);
    const oidcIdTokenAuthenticator = resolveOidcIdTokenAuthenticator(env);

    return {
      authenticateIdToken: ({ request, subjectToken }) =>
        authenticateOidcIdToken(subjectToken, request, oidcIdTokenAuthenticator),
      issueInstallationAccessToken: (context, tokenRequest) =>
        issueInstallationAccessTokenForContext(application, context, tokenRequest, dependencies),
      now: () => dependencies.now(),
      rateLimit: async (key) => {
        const result = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({ key });

        return result.success;
      },
    };
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
