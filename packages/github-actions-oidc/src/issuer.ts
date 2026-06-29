import type { TrustedOidcIssuer } from "@cyspbot/oidc";

const githubActionsIssuer = "https://token.actions.githubusercontent.com";
const githubActionsJwksUri = new URL(
  "https://token.actions.githubusercontent.com/.well-known/jwks",
);

export const githubActionsTrustedIssuer = {
  allowedSigningAlgorithms: ["RS256"],
  issuer: githubActionsIssuer,
  jwksUri: githubActionsJwksUri,
} satisfies TrustedOidcIssuer;
