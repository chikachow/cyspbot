import {
  createOidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticatorDependencies,
} from "@cyspbot/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@cyspbot/oidc/provider-registration";
import type { TokenPolicy } from "./policy/token-policy.ts";

const cyspbotSubjectTokenAudience = "cyspbot";

export function createTokenExchangeOidcIdTokenAuthenticator(
  providerRegistrations: readonly OidcProviderRegistration[],
  dependencies: OidcIdTokenAuthenticatorDependencies,
): OidcIdTokenAuthenticator {
  return createOidcIdTokenAuthenticator(
    {
      providerRegistrations,
      subjectTokenAudience: cyspbotSubjectTokenAudience,
    },
    dependencies,
  );
}

export function validateTokenPolicyIssuerIdentifiersHaveProviderRegistrations(
  tokenPolicy: TokenPolicy,
  providerRegistrations: readonly OidcProviderRegistration[],
): void {
  const registeredIssuerIdentifiers = new Set(
    providerRegistrations.map((providerRegistration) => providerRegistration.issuer),
  );

  for (const rule of tokenPolicy) {
    if (!registeredIssuerIdentifiers.has(rule.subject.issuer)) {
      throw new TypeError(
        `token policy rule "${rule.id}" references an OIDC Issuer Identifier without a Provider Registration`,
      );
    }
  }
}
