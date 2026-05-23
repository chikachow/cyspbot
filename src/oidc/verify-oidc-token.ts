import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, errors } from "jose";

import type { Clock, JwksSnapshot } from "./jwks-fetcher.ts";
import { fetchJwksSnapshot } from "./jwks-fetcher.ts";
import type { NormalizedJwk } from "./jwks-schema.ts";
import type {
  IssuerRegistration,
  VerifyOidcTokenFailure,
  VerifyOidcTokenResult,
} from "./principals.ts";
import {
  canAttemptRefresh,
  snapshotIsFresh,
  snapshotIsWithinStaleWindow,
  stateWithRefreshFailure,
  stateWithRefreshSuccess,
  type VerifierState,
} from "./verifier-state.ts";

export async function verifyOidcToken(
  token: string,
  registration: IssuerRegistration,
  state: VerifierState,
  clock: Clock,
  fetchImpl: typeof fetch,
  importedKeys: Map<string, Promise<CryptoKey>>,
): Promise<{ nextState: VerifierState; result: VerifyOidcTokenResult }> {
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
  let payloadHint: Record<string, unknown>;

  try {
    protectedHeader = decodeProtectedHeader(token);
    payloadHint = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return { nextState: state, result: failure(registration.issuer, "malformed_token") };
  }

  const alg = typeof protectedHeader.alg === "string" ? protectedHeader.alg : null;

  if (alg === null) {
    return { nextState: state, result: failure(registration.issuer, "unsupported_algorithm") };
  }

  if (!registration.allowedAlgorithms.includes(alg)) {
    return { nextState: state, result: failure(registration.issuer, "algorithm_not_allowed") };
  }

  const tokenIssuer = typeof payloadHint["iss"] === "string" ? payloadHint["iss"] : null;

  if (tokenIssuer !== registration.issuer) {
    return { nextState: state, result: failure(registration.issuer, "issuer_mismatch") };
  }

  const kid = typeof protectedHeader.kid === "string" ? protectedHeader.kid : null;

  if (registration.requireKid && kid === null) {
    return { nextState: state, result: failure(registration.issuer, "kid_required") };
  }

  const nowMs = clock.now();
  let nextState = state;
  let snapshot = state.snapshot;
  let refreshAttempted = false;
  const shouldAttemptRefresh =
    snapshot === null ||
    !snapshotIsFresh(snapshot, nowMs) ||
    shouldRefreshForUnknownKid(snapshot, kid, alg);

  if (shouldAttemptRefresh) {
    const refresh = await maybeRefreshSnapshot(nextState, registration, clock, fetchImpl);
    nextState = refresh.nextState;
    refreshAttempted = refresh.refreshAttempted;

    if (refresh.snapshot !== null) {
      snapshot = refresh.snapshot;
    }
  }

  if (snapshot === null) {
    return { nextState, result: failure(registration.issuer, "jwks_refresh_failed") };
  }

  const selection = selectCandidateKeys(snapshot, kid, alg);

  if (!selection.ok) {
    if (
      selection.reason === "no_matching_key" &&
      kid !== null &&
      !refreshAttempted &&
      canAttemptRefresh(nextState, nowMs)
    ) {
      const refresh = await maybeRefreshSnapshot(nextState, registration, clock, fetchImpl);
      nextState = refresh.nextState;

      if (refresh.snapshot !== null) {
        snapshot = refresh.snapshot;
      }

      const postRefreshSelection = selectCandidateKeys(snapshot, kid, alg);

      if (!postRefreshSelection.ok) {
        return { nextState, result: failure(registration.issuer, postRefreshSelection.reason) };
      }

      return verifyWithCandidates(
        token,
        registration,
        postRefreshSelection.keys,
        alg,
        importedKeys,
        nextState,
      );
    }

    return { nextState, result: failure(registration.issuer, selection.reason) };
  }

  return verifyWithCandidates(token, registration, selection.keys, alg, importedKeys, nextState);
}

async function maybeRefreshSnapshot(
  state: VerifierState,
  registration: IssuerRegistration,
  clock: Clock,
  fetchImpl: typeof fetch,
): Promise<{
  nextState: VerifierState;
  refreshAttempted: boolean;
  snapshot: JwksSnapshot | null;
}> {
  const nowMs = clock.now();

  if (!canAttemptRefresh(state, nowMs)) {
    if (snapshotIsWithinStaleWindow(state.snapshot, nowMs)) {
      return { nextState: state, refreshAttempted: false, snapshot: state.snapshot };
    }

    return { nextState: state, refreshAttempted: false, snapshot: null };
  }

  const refresh = await fetchJwksSnapshot(registration, clock, fetchImpl);

  if (!refresh.ok) {
    const nextState = stateWithRefreshFailure(state, registration, refresh.kind, nowMs);

    if (snapshotIsWithinStaleWindow(nextState.snapshot, nowMs)) {
      return { nextState, refreshAttempted: true, snapshot: nextState.snapshot };
    }

    return { nextState, refreshAttempted: true, snapshot: null };
  }

  const nextState = stateWithRefreshSuccess(state, refresh.snapshot);

  return { nextState, refreshAttempted: true, snapshot: refresh.snapshot };
}

function shouldRefreshForUnknownKid(
  snapshot: JwksSnapshot | null,
  kid: string | null,
  alg: string,
): boolean {
  if (snapshot === null || kid === null) {
    return false;
  }

  return !snapshot.keys.some((key) => key.kid === kid && keyMatchesAlgorithm(key, alg));
}

function selectCandidateKeys(
  snapshot: JwksSnapshot,
  kid: string | null,
  alg: string,
): { keys: NormalizedJwk[]; ok: true } | { ok: false; reason: VerifyOidcTokenFailure["reason"] } {
  const keys = snapshot.keys.filter((key) => {
    if (!keyMatchesAlgorithm(key, alg)) {
      return false;
    }

    if (kid !== null) {
      return key.kid === kid;
    }

    return true;
  });

  if (keys.length === 0) {
    return { ok: false, reason: "no_matching_key" };
  }

  if (kid === null && keys.length > 1) {
    return { ok: false, reason: "token_ambiguous" };
  }

  return { keys, ok: true };
}

function keyMatchesAlgorithm(key: NormalizedJwk, alg: string): boolean {
  if (key.alg !== undefined && key.alg !== alg) {
    return false;
  }

  switch (alg) {
    case "RS256":
    case "RS384":
    case "RS512":
    case "PS256":
    case "PS384":
    case "PS512":
      return key.kty === "RSA";
    case "ES256":
      return key.kty === "EC" && key.crv === "P-256";
    case "ES384":
      return key.kty === "EC" && key.crv === "P-384";
    case "ES512":
      return key.kty === "EC" && key.crv === "P-521";
    case "EdDSA":
      return key.kty === "OKP" && key.crv === "Ed25519";
    default:
      return false;
  }
}

async function verifyWithCandidates(
  token: string,
  registration: IssuerRegistration,
  keys: NormalizedJwk[],
  alg: string,
  importedKeys: Map<string, Promise<CryptoKey>>,
  nextState: VerifierState,
): Promise<{ nextState: VerifierState; result: VerifyOidcTokenResult }> {
  for (const key of keys) {
    try {
      const cryptoKey = await importedVerificationKey(importedKeys, key, alg);
      const { payload } = await jwtVerify(token, cryptoKey, {
        algorithms: [alg],
        audience: registration.audience,
        issuer: registration.issuer,
      });
      const principal = registration.mapPrincipal(payload as Record<string, unknown>);

      if (principal === null) {
        return { nextState, result: failure(registration.issuer, "invalid_claims") };
      }

      return {
        nextState,
        result: {
          issuer: registration.issuer,
          ok: true,
          principal,
          resolvedKeyId: key.kid,
        },
      };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        return { nextState, result: failure(registration.issuer, "expired") };
      }

      if (error instanceof errors.JWTClaimValidationFailed) {
        if (error.claim === "nbf") {
          return { nextState, result: failure(registration.issuer, "not_yet_valid") };
        }

        if (error.claim === "aud") {
          return { nextState, result: failure(registration.issuer, "audience_mismatch") };
        }

        if (error.claim === "iss") {
          return { nextState, result: failure(registration.issuer, "issuer_mismatch") };
        }

        return { nextState, result: failure(registration.issuer, "invalid_claims") };
      }

      if (error instanceof errors.JWSSignatureVerificationFailed) {
        continue;
      }

      return { nextState, result: failure(registration.issuer, "invalid_token") };
    }
  }

  return { nextState, result: failure(registration.issuer, "invalid_signature") };
}

function importedVerificationKey(
  importedKeys: Map<string, Promise<CryptoKey>>,
  key: NormalizedJwk,
  alg: string,
): Promise<CryptoKey> {
  const cacheKey = JSON.stringify([alg, key.kid, key.kty, key.crv, key.n, key.e, key.x, key.y]);
  const cached = importedKeys.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const imported = importJWK(denormalizeJwk(key), alg) as Promise<CryptoKey>;
  importedKeys.set(cacheKey, imported);

  return imported;
}

function denormalizeJwk(key: NormalizedJwk): Record<string, string> {
  const jwk: Record<string, string> = {
    kty: key.kty,
  };

  if (key.alg !== undefined) {
    jwk["alg"] = key.alg;
  }

  if (key.crv !== undefined) {
    jwk["crv"] = key.crv;
  }

  if (key.e !== undefined) {
    jwk["e"] = key.e;
  }

  if (key.kid !== null) {
    jwk["kid"] = key.kid;
  }

  if (key.n !== undefined) {
    jwk["n"] = key.n;
  }

  if (key.x !== undefined) {
    jwk["x"] = key.x;
  }

  if (key.y !== undefined) {
    jwk["y"] = key.y;
  }

  return jwk;
}

function failure(issuer: string, reason: VerifyOidcTokenFailure["reason"]): VerifyOidcTokenFailure {
  return {
    issuer,
    ok: false,
    reason,
  };
}
