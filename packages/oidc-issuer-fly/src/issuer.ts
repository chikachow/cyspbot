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
    validateSubjectTokenBinding: (input) =>
      validateFlySubjectTokenBinding({
        ...input,
        expectedIssuerIdentifier: issuerIdentifier,
        expectedOrganizationSlug: organizationSlug,
      }),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateFlySubjectTokenBinding(input: {
  expectedIssuerIdentifier: string;
  expectedOrganizationSlug: string;
  verifiedToken: VerifiedOidcIdToken;
}): boolean {
  const { expectedIssuerIdentifier, expectedOrganizationSlug, verifiedToken } = input;
  const { claims, issuer } = verifiedToken;
  const appId = claims["app_id"];
  const appName = claims["app_name"];
  const machineId = claims["machine_id"];
  const machineName = claims["machine_name"];
  const machineVersion = claims["machine_version"];
  const orgId = claims["org_id"];
  const orgName = claims["org_name"];

  return (
    issuer === expectedIssuerIdentifier &&
    typeof claims.nbf === "number" &&
    isNonEmptyString(appId) &&
    isNonEmptyString(appName) &&
    isNonEmptyString(machineId) &&
    isNonEmptyString(machineName) &&
    isNonEmptyString(machineVersion) &&
    isNonEmptyString(orgId) &&
    isNonEmptyString(orgName) &&
    orgName === expectedOrganizationSlug &&
    claims.sub === `${orgName}:${appName}:${machineName}`
  );
}
