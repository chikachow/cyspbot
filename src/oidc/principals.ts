export interface AuthenticatedContext {
  issuerRegistration: IssuerRegistration;
  principal: AuthenticatedPrincipal;
  resolvedKeyId: string | null;
}

export interface GitHubActionsPrincipal {
  actor: string | null;
  baseRef: string | null;
  environment: string | null;
  eventName: string;
  headRef: string | null;
  jobWorkflowRef: string | null;
  rawSubject: string;
  ref: string | null;
  refType: string | null;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string | null;
  repositoryVisibility: string | null;
  runAttempt: string | null;
  runId: string | null;
  sha: string | null;
  subjectContextKind: string | null;
  subjectContextValue: string | null;
  subjectRepository: string | null;
  type: "github-actions";
  workflow: string | null;
  workflowRef: string | null;
}

export type AuthenticatedPrincipal = GitHubActionsPrincipal;

export interface IssuerRegistrationBase {
  allowedAlgorithms: string[];
  audience: string;
  defaultFreshMs: number;
  issuer: string;
  jwksUri: string;
  mapPrincipal(payload: Record<string, unknown>): AuthenticatedPrincipal | null;
  maxBackoffMs: number;
  maxFreshMs: number;
  minFreshMs: number;
  principalKind: "github-actions";
  refreshBackoffBaseMs: number;
  requireKid: boolean;
  staleWhileErrorMs: number;
}

export type IssuerRegistration = IssuerRegistrationBase;

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
