export interface AuthenticatedContext {
  issuerRegistration: IssuerRegistration;
  principal: AuthenticatedPrincipal;
  resolvedKeyId: string | null;
}

export interface GitHubActionsPrincipal {
  actor: string | null;
  eventName: string;
  ref: string | null;
  repository: string;
  repositoryId: string;
  runAttempt: string | null;
  runId: string | null;
  sha: string | null;
  type: "github-actions";
  workflow: string | null;
}

export type AuthenticatedPrincipal = GitHubActionsPrincipal;

export interface IssuerRegistrationBase {
  allowedAlgorithms: string[];
  audience: string;
  defaultFreshMs: number;
  issuer: string;
  mapPrincipal(payload: Record<string, unknown>): AuthenticatedPrincipal | null;
  maxBackoffMs: number;
  maxFreshMs: number;
  minFreshMs: number;
  principalKind: "github-actions";
  refreshBackoffBaseMs: number;
  requireKid: boolean;
  staleWhileErrorMs: number;
}

export interface RemoteJwksIssuerRegistration extends IssuerRegistrationBase {
  jwksUri: string;
  source: "remote-jwks";
}

export interface StaticPemIssuerRegistration extends IssuerRegistrationBase {
  keyId: string | null;
  publicKeyPemBase64: string;
  source: "static-public-key";
}

export type IssuerRegistration = RemoteJwksIssuerRegistration | StaticPemIssuerRegistration;

export interface VerifyOidcTokenSuccess {
  issuer: string;
  ok: true;
  principal: AuthenticatedPrincipal;
  resolvedKeyId: string | null;
}

export type VerifyOidcTokenFailureReason =
  | "algorithm_not_allowed"
  | "audience_mismatch"
  | "configuration_error"
  | "expired"
  | "invalid_claims"
  | "invalid_signature"
  | "invalid_token"
  | "issuer_mismatch"
  | "jwks_refresh_failed"
  | "kid_required"
  | "malformed_token"
  | "missing_issuer"
  | "no_matching_key"
  | "not_yet_valid"
  | "token_ambiguous"
  | "unsupported_algorithm";

export interface VerifyOidcTokenFailure {
  issuer: string;
  ok: false;
  reason: VerifyOidcTokenFailureReason;
}

export type VerifyOidcTokenResult = VerifyOidcTokenFailure | VerifyOidcTokenSuccess;
