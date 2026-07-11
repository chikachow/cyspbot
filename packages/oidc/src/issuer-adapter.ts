import type { TrustedOidcIssuer, VerifiedOidcToken } from "./verifier.ts";

type OidcIssuerResolution =
  | { status: "configured"; trustedIssuer: TrustedOidcIssuer }
  | { status: "unavailable" }
  | { status: "unhandled" };

export interface OidcIssuerAdapter {
  resolveIssuer(issuer: string): OidcIssuerResolution;
  validateSubjectTokenBinding(input: {
    claims: VerifiedOidcToken["claims"];
    expectedAudience: string;
    /** The issuer established by central signature and issuer verification. */
    verifiedIssuer: string;
  }): boolean;
}
