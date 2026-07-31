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
import { createTokenExchangeOidcIdTokenAuthenticator } from "./oidc-authentication.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "./policy/token-issuance-policy.ts";
import { configuredTokenIssuancePolicy } from "./policy/configured-token-issuance-policy.ts";
import { configuredOidcProviderRegistrations } from "./configured-oidc-provider-registrations.ts";
import type { TokenExchangeApplication } from "./token-exchange-application.ts";
import type { OidcIdTokenAuthenticatorDependencies } from "@cyspbot/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@cyspbot/oidc/provider-registration";

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
  oidcProviderRegistrations: readonly OidcProviderRegistration[];
  tokenIssuancePolicy: TokenIssuancePolicy;
}

export const defaultTokenExchangeWorkerDependencies: TokenExchangeWorkerDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  oidcProviderRegistrations: configuredOidcProviderRegistrations,
  tokenIssuancePolicy: configuredTokenIssuancePolicy,
};

export function createTokenExchangeRequestRuntimeFactory(
  dependencies: TokenExchangeWorkerDependencies,
): (env: TokenExchangeEnv) => TokenExchangeRequestRuntime {
  assertTokenIssuancePolicyIssuersAreRegistered(
    dependencies.tokenIssuancePolicy,
    dependencies.oidcProviderRegistrations,
  );

  const oidcIdTokenAuthenticatorDependencies: OidcIdTokenAuthenticatorDependencies = {
    fetch: (input, init) => dependencies.fetch(input, init),
    now: () => dependencies.now(),
    observe: (event) => console.warn(event),
  };
  const oidcIdTokenAuthenticator = createTokenExchangeOidcIdTokenAuthenticator(
    dependencies.oidcProviderRegistrations,
    oidcIdTokenAuthenticatorDependencies,
  );

  return (env) => {
    const application = tokenExchangeApplication(env, dependencies.tokenIssuancePolicy);

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
  tokenIssuancePolicy: TokenIssuancePolicy,
): TokenExchangeApplication {
  return {
    githubApp: {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL }),
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    },
    tokenIssuancePolicy,
  };
}
