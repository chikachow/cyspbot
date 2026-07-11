import type { TrustedOidcIssuer, VerifiedOidcToken } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

const flyIssuerPrefix = "https://oidc.fly.io/";
const flyOrgSlugPattern = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/u;

export function flyIssuerAdapter(configuredOrgSlugs: string): OidcIssuerAdapter {
  const trustedIssuers = parseTrustedIssuers(configuredOrgSlugs);

  return {
    resolveIssuer: (issuer) => {
      if (!issuer.startsWith(flyIssuerPrefix)) {
        return { status: "unhandled" };
      }

      if (trustedIssuers === null) {
        return { status: "unavailable" };
      }

      const trustedIssuer = trustedIssuers.get(issuer);

      return trustedIssuer === undefined
        ? { status: "unhandled" }
        : { status: "configured", trustedIssuer };
    },
    validateSubjectTokenBinding: validateFlySubjectTokenBinding,
  };
}

export function flyIssuerForOrgSlug(orgSlug: string): string | null {
  return flyOrgSlugPattern.test(orgSlug) ? `${flyIssuerPrefix}${orgSlug}` : null;
}

function parseTrustedIssuers(value: string): ReadonlyMap<string, TrustedOidcIssuer> | null {
  const slugs = value
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);

  if (slugs.length === 0) {
    return new Map();
  }

  if (slugs.some((slug) => flyIssuerForOrgSlug(slug) === null)) {
    return null;
  }

  return new Map(
    slugs.map((slug) => {
      const issuer = flyIssuerForOrgSlug(slug);

      if (issuer === null) {
        throw new Error("validated Fly organization slug did not produce an issuer");
      }

      return [
        issuer,
        {
          allowedSigningAlgorithms: ["RS256"],
          issuer,
          jwksUri: new URL(`${issuer}/.well-known/jwks`),
        } satisfies TrustedOidcIssuer,
      ];
    }),
  );
}

function flyOrgSlugForIssuer(issuer: string): string | null {
  const orgSlug = issuer.startsWith(flyIssuerPrefix) ? issuer.slice(flyIssuerPrefix.length) : "";

  return flyOrgSlugPattern.test(orgSlug) ? orgSlug : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateFlySubjectTokenBinding(input: {
  claims: VerifiedOidcToken["claims"];
  expectedAudience: string;
  verifiedIssuer: string;
}): boolean {
  const { claims, expectedAudience, verifiedIssuer } = input;
  const appId = claims["app_id"];
  const appName = claims["app_name"];
  const machineId = claims["machine_id"];
  const machineName = claims["machine_name"];
  const machineVersion = claims["machine_version"];
  const orgId = claims["org_id"];
  const orgName = claims["org_name"];

  return (
    isNonEmptyString(claims.sub) &&
    typeof claims.exp === "number" &&
    typeof claims.nbf === "number" &&
    isNonEmptyString(appId) &&
    isNonEmptyString(appName) &&
    isNonEmptyString(machineId) &&
    isNonEmptyString(machineName) &&
    isNonEmptyString(machineVersion) &&
    isNonEmptyString(orgId) &&
    isNonEmptyString(orgName) &&
    orgName === flyOrgSlugForIssuer(verifiedIssuer) &&
    claims.sub === `${orgName}:${appName}:${machineName}` &&
    (claims["azp"] === undefined || claims["azp"] === expectedAudience)
  );
}
