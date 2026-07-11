import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

export const googleServiceAccountTrustedIssuer = {
  allowedSigningAlgorithms: ["RS256"],
  issuer: "https://accounts.google.com",
  jwksUri: new URL("https://www.googleapis.com/oauth2/v3/certs"),
} satisfies TrustedOidcIssuer;

export const googleServiceAccountIssuerAdapter: OidcIssuerAdapter = {
  resolveIssuer: (unverifiedIssuer) =>
    unverifiedIssuer === googleServiceAccountTrustedIssuer.issuer
      ? { status: "configured", trustedIssuer: googleServiceAccountTrustedIssuer }
      : { status: "unhandled" },
  validateSubjectTokenBinding: ({ verifiedToken: { claims } }) => claims["azp"] === claims.sub,
};
