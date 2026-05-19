import { Buffer } from "node:buffer";

import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload } from "jose";

import type { Env } from "../env.ts";

const defaultIssuer = "https://token.actions.githubusercontent.com";
const defaultJwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const staticPublicKeysByPemBase64 = new Map<string, Promise<CryptoKey>>();

export class OidcAuthenticationError extends Error {}

export interface VerifiedCaller {
  actor: string | null;
  eventName: string;
  ref: string | null;
  repository: string;
  repositoryId: string;
  runAttempt: string | null;
  runId: string | null;
  sha: string | null;
  workflow: string | null;
}

export async function verifyGithubActionsOidcBearerToken(
  authorizationHeader: string | null,
  env: Env,
): Promise<VerifiedCaller> {
  const token = extractBearerToken(authorizationHeader);

  if (token === null) {
    throw new OidcAuthenticationError("missing bearer token");
  }

  try {
    const verificationOptions = {
      audience: env.GITHUB_ACTIONS_OIDC_AUDIENCE,
      issuer: env.GITHUB_ACTIONS_OIDC_ISSUER ?? defaultIssuer,
    };
    const { payload } =
      env.GITHUB_ACTIONS_OIDC_PUBLIC_KEY_PEM_BASE64 !== undefined
        ? await jwtVerify(token, await staticOidcVerificationKey(env), verificationOptions)
        : await jwtVerify(token, remoteOidcVerificationKey(env), verificationOptions);

    return verifiedCallerFromPayload(payload);
  } catch (error) {
    throw new OidcAuthenticationError(String(error));
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
    return null;
  }

  return token;
}

function staticOidcVerificationKey(env: Env): Promise<CryptoKey> {
  const publicKeyPemBase64 = env.GITHUB_ACTIONS_OIDC_PUBLIC_KEY_PEM_BASE64;

  if (publicKeyPemBase64 === undefined) {
    throw new OidcAuthenticationError("missing static OIDC verification key");
  }

  const cached = staticPublicKeysByPemBase64.get(publicKeyPemBase64);

  if (cached !== undefined) {
    return cached;
  }

  const publicKeyPem = Buffer.from(publicKeyPemBase64, "base64").toString("utf8");
  const imported = importSPKI(publicKeyPem, "RS256");
  staticPublicKeysByPemBase64.set(publicKeyPemBase64, imported);

  return imported;
}

function remoteOidcVerificationKey(env: Env) {
  const jwksUrl = env.GITHUB_ACTIONS_OIDC_JWKS_URL ?? defaultJwksUrl;
  const cached = jwksByUrl.get(jwksUrl);

  if (cached !== undefined) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  jwksByUrl.set(jwksUrl, jwks);

  return jwks;
}

function verifiedCallerFromPayload(payload: JWTPayload): VerifiedCaller {
  const eventName = stringClaim(payload, "event_name");
  const repository = stringClaim(payload, "repository");
  const repositoryId = stringClaim(payload, "repository_id");

  return {
    actor: optionalStringClaim(payload, "actor"),
    eventName,
    ref: optionalStringClaim(payload, "ref"),
    repository,
    repositoryId,
    runAttempt: optionalStringClaim(payload, "run_attempt"),
    runId: optionalStringClaim(payload, "run_id"),
    sha: optionalStringClaim(payload, "sha"),
    workflow: optionalStringClaim(payload, "workflow"),
  };
}

function stringClaim(payload: JWTPayload, claim: string): string {
  const value = payload[claim];

  if (typeof value !== "string" || value.length === 0) {
    throw new OidcAuthenticationError(`missing ${claim}`);
  }

  return value;
}

function optionalStringClaim(payload: JWTPayload, claim: string): string | null {
  const value = payload[claim];

  if (value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new OidcAuthenticationError(`invalid ${claim}`);
  }

  return value;
}
