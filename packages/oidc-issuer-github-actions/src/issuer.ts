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
  resolveIssuer: (issuer) =>
    issuer === githubActionsTrustedIssuer.issuer
      ? { status: "configured", trustedIssuer: githubActionsTrustedIssuer }
      : { status: "unhandled" },
  validateSubjectTokenBinding: ({ claims, expectedAudience }) =>
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    typeof claims.exp === "number" &&
    (claims["azp"] === undefined || claims["azp"] === expectedAudience),
};
