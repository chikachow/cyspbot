import type { JWTPayload } from "jose";

import type { OidcIssuerIdentifier } from "./provider-registration.ts";

export interface VerifiedOidcIdTokenClaims extends JWTPayload {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
}

export interface VerifiedOidcIdToken {
  claims: VerifiedOidcIdTokenClaims;
  issuer: OidcIssuerIdentifier;
  resolvedKeyId: string | null;
}
