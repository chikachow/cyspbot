import {
  createInstallationAccessTokenExchange,
  type InstallationAccessTokenExchange,
} from "./installation-access-token-exchange.ts";
import { createTokenExchangeOidcIdTokenAuthenticator } from "./oidc-authentication.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "./policy/token-issuance-policy.ts";
import { configuredTokenIssuancePolicy } from "./policy/configured-token-issuance-policy.ts";
import { configuredOidcProviderRegistrations } from "./configured-oidc-provider-registrations.ts";
import type { OidcIdTokenAuthenticatorDependencies } from "@cyspbot/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@cyspbot/oidc/provider-registration";

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

export function createInstallationAccessTokenExchangeForWorker(
  dependencies: TokenExchangeWorkerDependencies,
): InstallationAccessTokenExchange {
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

  return createInstallationAccessTokenExchange({
    githubAppDependencies: dependencies,
    oidcIdTokenAuthenticator,
    tokenIssuancePolicy: dependencies.tokenIssuancePolicy,
  });
}
