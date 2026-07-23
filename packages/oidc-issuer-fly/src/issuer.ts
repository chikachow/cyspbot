import type { TrustedOidcIssuer, VerifiedOidcIdToken } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

const flyIssuerPrefix = "https://oidc.fly.io/";
const flyIssuerPathSegmentPattern = /^[a-z0-9-]+$/u;

export function flyIssuerIdentifierForOrganizationSlug(organizationSlug: string): string | null {
  return flyIssuerPathSegmentPattern.test(organizationSlug)
    ? `${flyIssuerPrefix}${organizationSlug}`
    : null;
}

export function flyIssuerAdapter(organizationSlug: string): OidcIssuerAdapter {
  const issuerIdentifier = flyIssuerIdentifierForOrganizationSlug(organizationSlug);

  if (issuerIdentifier === null) {
    throw new TypeError("unsupported Fly issuer path syntax");
  }

  const trustedIssuer = {
    allowedSigningAlgorithms: ["RS256"],
    issuer: issuerIdentifier,
    jwksUri: new URL(`${issuerIdentifier}/.well-known/jwks`),
  } satisfies TrustedOidcIssuer;

  return {
    resolveIssuer: (candidateIssuer) =>
      candidateIssuer === issuerIdentifier
        ? { status: "configured", trustedIssuer }
        : { status: "unhandled" },
    validateSubjectTokenBinding: ({ verifiedToken }) =>
      validateFlySubjectTokenBinding({
        expectedOrganizationSlug: organizationSlug,
        verifiedToken,
      }),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateFlySubjectTokenBinding(input: {
  expectedOrganizationSlug: string;
  verifiedToken: VerifiedOidcIdToken;
}): boolean {
  const { expectedOrganizationSlug, verifiedToken } = input;
  const { claims } = verifiedToken;
  const appName = claims["app_name"];
  const machineName = claims["machine_name"];
  const orgName = claims["org_name"];

  return (
    isNonEmptyString(appName) &&
    isNonEmptyString(machineName) &&
    isNonEmptyString(orgName) &&
    orgName === expectedOrganizationSlug &&
    claims.sub === `${orgName}:${appName}:${machineName}`
  );
}
