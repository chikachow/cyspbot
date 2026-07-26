import {
  createFlyOidcProviderRegistration,
  flyOidcIssuerIdentifierForOrganizationSlug,
} from "@cyspbot/oidc-provider-fly";
import { githubActionsOidcProviderRegistration } from "@cyspbot/oidc-provider-github-actions";
import { googleServiceAccountOidcProviderRegistration } from "@cyspbot/oidc-provider-google-service-account";
import {
  createOidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticatorDependencies,
} from "@cyspbot/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@cyspbot/oidc/provider-registration";
import type { TokenPolicy } from "./policy/token-policy.ts";

const cyspbotSubjectTokenAudience = "cyspbot";

export function configuredOidcProviderRegistrations(env: {
  FLY_OIDC_ORG_SLUGS?: string;
}): readonly OidcProviderRegistration[] {
  const flyConfiguration = env.FLY_OIDC_ORG_SLUGS;
  const flyProviderRegistrations =
    flyConfiguration === undefined || flyConfiguration === ""
      ? []
      : parseFlyOidcProviderRegistrations(flyConfiguration);

  return Object.freeze([
    ...flyProviderRegistrations,
    githubActionsOidcProviderRegistration,
    googleServiceAccountOidcProviderRegistration,
  ]);
}

export function createOidcIdTokenAuthenticatorResolver(
  dependencies: OidcIdTokenAuthenticatorDependencies,
  tokenPolicy: TokenPolicy,
): (env: { FLY_OIDC_ORG_SLUGS?: string }) => OidcIdTokenAuthenticator {
  const authenticatorsByFlyConfiguration = new Map<string | undefined, OidcIdTokenAuthenticator>();

  return (env) => {
    const flyConfiguration = env.FLY_OIDC_ORG_SLUGS;
    const cachedAuthenticator = authenticatorsByFlyConfiguration.get(flyConfiguration);

    if (cachedAuthenticator !== undefined) {
      return cachedAuthenticator;
    }

    const providerRegistrations = configuredOidcProviderRegistrations(env);

    validateTokenPolicyIssuerIdentifiersHaveProviderRegistrations(
      tokenPolicy,
      providerRegistrations,
    );

    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations,
        subjectTokenAudience: cyspbotSubjectTokenAudience,
      },
      dependencies,
    );

    authenticatorsByFlyConfiguration.set(flyConfiguration, authenticator);

    return authenticator;
  };
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

function parseFlyOidcProviderRegistrations(
  flyConfiguration: string,
): readonly OidcProviderRegistration[] {
  const organizationSlugs = flyConfiguration.split(",").map((entry) => entry.trim());
  const seenOrganizationSlugs = new Set<string>();

  for (const [entryIndex, organizationSlug] of organizationSlugs.entries()) {
    if (organizationSlug.length === 0) {
      throw new TypeError(`FLY_OIDC_ORG_SLUGS entry ${entryIndex} must not be empty`);
    }

    if (seenOrganizationSlugs.has(organizationSlug)) {
      throw new TypeError(`FLY_OIDC_ORG_SLUGS entry ${entryIndex} duplicates an organization slug`);
    }

    if (flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug) === null) {
      throw new TypeError(`FLY_OIDC_ORG_SLUGS entry ${entryIndex} has unsupported syntax`);
    }

    seenOrganizationSlugs.add(organizationSlug);
  }

  return organizationSlugs.map(createFlyOidcProviderRegistration);
}
