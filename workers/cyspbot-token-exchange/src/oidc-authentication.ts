import {
  createOidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticatorDependencies,
} from "@cyspbot/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@cyspbot/oidc/provider-registration";

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
