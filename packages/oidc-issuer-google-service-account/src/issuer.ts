import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

export const googleServiceAccountTrustedIssuer = {
  allowedSigningAlgorithms: ["RS256"],
  issuer: "https://accounts.google.com",
  jwksUri: new URL("https://www.googleapis.com/oauth2/v3/certs"),
} satisfies TrustedOidcIssuer;

export const googleServiceAccountIssuerAdapter = {
  resolveIssuer: (issuer) =>
    issuer === googleServiceAccountTrustedIssuer.issuer
      ? { status: "configured" as const, trustedIssuer: googleServiceAccountTrustedIssuer }
      : { status: "unhandled" as const },
  validateSubjectTokenBinding: ({ claims, verifiedIssuer }) =>
    verifiedIssuer === googleServiceAccountTrustedIssuer.issuer &&
    typeof claims["azp"] === "string" &&
    claims["azp"].length > 0 &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    typeof claims.exp === "number" &&
    claims["azp"] === claims.sub,
} satisfies OidcIssuerAdapter;
