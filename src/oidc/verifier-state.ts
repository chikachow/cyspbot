import type { JwksFetchFailureKind, JwksSnapshot } from "./jwks-fetcher.ts";
import type { IssuerRegistration } from "./principals.ts";
import type { NormalizedJwk } from "./jwks-schema.ts";

export interface PersistedVerifierState {
  backoff: PersistedVerifierBackoffState;
  fingerprint: string;
  snapshot: PersistedJwksSnapshot | null;
}

export interface PersistedVerifierBackoffState {
  consecutiveInvalidJwksFailures: number;
  consecutiveTransportFailures: number;
  nextAttemptNotBeforeMs: number;
}

export interface PersistedJwksSnapshot {
  fetchedAtMs: number;
  freshUntilMs: number;
  keys: NormalizedJwk[];
  staleUntilMs: number;
}

export interface VerifierState {
  backoff: PersistedVerifierBackoffState;
  fingerprint: string;
  snapshot: JwksSnapshot | null;
}

export function emptyVerifierState(fingerprint: string): VerifierState {
  return {
    backoff: {
      consecutiveInvalidJwksFailures: 0,
      consecutiveTransportFailures: 0,
      nextAttemptNotBeforeMs: 0,
    },
    fingerprint,
    snapshot: null,
  };
}

export function hydrateVerifierState(
  persistedState: PersistedVerifierState,
  registration: IssuerRegistration,
): VerifierState {
  const fingerprint = registrationFingerprint(registration);

  if (persistedState.fingerprint !== fingerprint) {
    return emptyVerifierState(fingerprint);
  }

  return {
    backoff: persistedState.backoff,
    fingerprint,
    snapshot: persistedState.snapshot,
  };
}

export function persistVerifierState(state: VerifierState): PersistedVerifierState {
  return {
    backoff: state.backoff,
    fingerprint: state.fingerprint,
    snapshot: state.snapshot,
  };
}

export function registrationFingerprint(registration: IssuerRegistration): string {
  return JSON.stringify({
    allowedAlgorithms: registration.allowedAlgorithms,
    issuer: registration.issuer,
    jwksUri: registration.jwksUri,
    principalKind: registration.principalKind,
    requireKid: registration.requireKid,
  });
}

export function snapshotIsFresh(snapshot: JwksSnapshot | null, nowMs: number): boolean {
  return snapshot !== null && nowMs <= snapshot.freshUntilMs;
}

export function snapshotIsWithinStaleWindow(snapshot: JwksSnapshot | null, nowMs: number): boolean {
  return snapshot !== null && nowMs <= snapshot.staleUntilMs;
}

export function canAttemptRefresh(state: VerifierState, nowMs: number): boolean {
  return nowMs >= state.backoff.nextAttemptNotBeforeMs;
}

export function stateWithRefreshSuccess(
  state: VerifierState,
  snapshot: JwksSnapshot,
): VerifierState {
  return {
    backoff: {
      consecutiveInvalidJwksFailures: 0,
      consecutiveTransportFailures: 0,
      nextAttemptNotBeforeMs: 0,
    },
    fingerprint: state.fingerprint,
    snapshot,
  };
}

export function stateWithRefreshFailure(
  state: VerifierState,
  registration: IssuerRegistration,
  kind: JwksFetchFailureKind,
  nowMs: number,
): VerifierState {
  const transportFailures =
    kind === "transport" ? state.backoff.consecutiveTransportFailures + 1 : 0;
  const invalidJwksFailures =
    kind === "invalid-jwks" ? state.backoff.consecutiveInvalidJwksFailures + 1 : 0;
  const attempts = Math.max(transportFailures, invalidJwksFailures);
  const backoffMs = Math.min(
    registration.refreshBackoffBaseMs * 2 ** Math.max(attempts - 1, 0),
    registration.maxBackoffMs,
  );

  return {
    backoff: {
      consecutiveInvalidJwksFailures: invalidJwksFailures,
      consecutiveTransportFailures: transportFailures,
      nextAttemptNotBeforeMs: nowMs + backoffMs,
    },
    fingerprint: state.fingerprint,
    snapshot: state.snapshot,
  };
}
