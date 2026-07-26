import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
  type OidcIdTokenProfile,
  type OidcIssuerIdentifier,
  type OidcProviderRegistration,
} from "@cyspbot/oidc/provider-registration";

const flyOidcIssuerPrefix = "https://oidc.fly.io/";
const flyOrganizationSlugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function flyOidcIssuerIdentifierForOrganizationSlug(
  organizationSlug: string,
): OidcIssuerIdentifier | null {
  return flyOrganizationSlugPattern.test(organizationSlug)
    ? parseOidcIssuerIdentifier(`${flyOidcIssuerPrefix}${organizationSlug}`)
    : null;
}

export function createFlyOidcProviderRegistration(
  organizationSlug: string,
): OidcProviderRegistration {
  const issuer = flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug);

  if (issuer === null) {
    throw new TypeError("unsupported Fly organization slug");
  }

  const idTokenProfile: OidcIdTokenProfile = {
    validate: (claims) => {
      const appName = claims["app_name"];
      const machineName = claims["machine_name"];
      const orgName = claims["org_name"];

      return (
        isNonEmptyString(appName) &&
        isNonEmptyString(machineName) &&
        orgName === organizationSlug &&
        claims.sub === `${orgName}:${appName}:${machineName}`
      );
    },
  };

  return createOidcProviderRegistration({
    acceptedIdTokenSigningAlgorithms: ["RS256"],
    idTokenProfile,
    issuer,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
