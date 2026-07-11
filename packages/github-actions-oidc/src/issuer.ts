import type { OidcIssuerAdapter } from "@cyspbot/oidc/issuer-adapter";
import type { TrustedOidcIssuer } from "@cyspbot/oidc";
import {
  deriveGitHubActionsPrincipal,
  parseGitHubActionsClaims,
} from "./github-actions-principal.ts";
import type { GitHubActionsPrincipal } from "./principals.ts";

const githubActionsIssuer = "https://token.actions.githubusercontent.com";
const githubActionsJwksUri = new URL(
  "https://token.actions.githubusercontent.com/.well-known/jwks",
);

export const githubActionsTrustedIssuer = {
  allowedSigningAlgorithms: ["RS256"],
  issuer: githubActionsIssuer,
  jwksUri: githubActionsJwksUri,
} satisfies TrustedOidcIssuer;

export const githubActionsIssuerAdapter: OidcIssuerAdapter<GitHubActionsPrincipal> = {
  derivePrincipal: (claims) => {
    const parsedClaims = parseGitHubActionsClaims(claims);

    return parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);
  },
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
