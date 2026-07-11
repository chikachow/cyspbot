import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";

const githubActionsIssuer = "https://token.actions.githubusercontent.com";
const githubActionsJwksUri = new URL(
  "https://token.actions.githubusercontent.com/.well-known/jwks",
);

export const githubActionsTrustedIssuer = {
  allowedSigningAlgorithms: ["RS256"],
  issuer: githubActionsIssuer,
  jwksUri: githubActionsJwksUri,
} satisfies TrustedOidcIssuer;

export const githubActionsIssuerAdapter: OidcIssuerAdapter = {
  resolveIssuer: (unverifiedIssuer) =>
    unverifiedIssuer === githubActionsTrustedIssuer.issuer
      ? { status: "configured", trustedIssuer: githubActionsTrustedIssuer }
      : { status: "unhandled" },
  validateSubjectTokenBinding: ({ expectedAudience, verifiedToken }) =>
    typeof verifiedToken.claims.sub === "string" &&
    verifiedToken.claims.sub.length > 0 &&
    typeof verifiedToken.claims.exp === "number" &&
    (verifiedToken.claims["azp"] === undefined || verifiedToken.claims["azp"] === expectedAudience),
};
