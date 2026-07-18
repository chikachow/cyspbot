import type { TrustedOidcIssuer, VerifiedOidcIdToken } from "./verifier.ts";

type OidcIssuerResolution =
  | { status: "configured"; trustedIssuer: TrustedOidcIssuer }
  | { status: "unhandled" };

export interface OidcIssuerAdapter {
  resolveIssuer(unverifiedIssuer: string): OidcIssuerResolution;
  validateSubjectTokenBinding(input: {
    expectedAudience: string;
    verifiedToken: VerifiedOidcIdToken;
  }): boolean;
}
