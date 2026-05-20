import type { RawIssuerRegistration } from "./config-schema.ts";

export const rawIssuerRegistrations = [
  {
    allowedAlgorithms: ["RS256"],
    audience: "cyspbot",
    defaultFreshMs: 5 * 60 * 1000,
    issuer: "https://token.actions.githubusercontent.com",
    jwksUri: "https://token.actions.githubusercontent.com/.well-known/jwks",
    maxBackoffMs: 5 * 60 * 1000,
    maxFreshMs: 15 * 60 * 1000,
    minFreshMs: 60 * 1000,
    principalKind: "github-actions",
    refreshBackoffBaseMs: 5 * 1000,
    requireKid: true,
    staleWhileErrorMs: 10 * 60 * 1000,
  },
] satisfies RawIssuerRegistration[];
