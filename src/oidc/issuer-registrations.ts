import { Buffer } from "node:buffer";

import { exportJWK, importSPKI } from "jose";

import type { Env } from "../env.ts";
import type { RawIssuerRegistration } from "./config-schema.ts";
import {
  rawIssuerRegistrationsSchema,
  testStaticPublicKeyOverrideSchema,
} from "./config-schema.ts";
import { rawIssuerRegistrations } from "./issuer-registrations-config.ts";
import type {
  AuthenticatedPrincipal,
  GitHubActionsPrincipal,
  IssuerRegistration,
} from "./principals.ts";

let validatedRawRegistrations: readonly RawIssuerRegistration[] | null = null;
const registrationsByOverrideKey = new Map<string, Promise<readonly IssuerRegistration[]>>();

export class OidcConfigurationError extends Error {}

export async function loadIssuerRegistrations(env: Env): Promise<readonly IssuerRegistration[]> {
  const overrideKey = `${env.TEST_OIDC_STATIC_PUBLIC_KEY_PEM_BASE64 ?? ""}:${env.TEST_OIDC_STATIC_KEY_ID ?? ""}`;
  const cached = registrationsByOverrideKey.get(overrideKey);

  if (cached !== undefined) {
    return cached;
  }

  const pending = loadIssuerRegistrationsUncached(env);
  registrationsByOverrideKey.set(overrideKey, pending);

  return pending;
}

export async function loadIssuerRegistrationByIssuer(
  env: Env,
  issuer: string,
): Promise<IssuerRegistration | null> {
  const registrations = await loadIssuerRegistrations(env);

  return registrations.find((registration) => registration.issuer === issuer) ?? null;
}

async function loadIssuerRegistrationsUncached(env: Env): Promise<readonly IssuerRegistration[]> {
  const rawRegistrations = validatedRawIssuerRegistrations();
  const registrations: IssuerRegistration[] = [];

  for (const rawRegistration of rawRegistrations) {
    registrations.push(await materializeIssuerRegistration(rawRegistration, env));
  }

  return registrations;
}

function validatedRawIssuerRegistrations(): readonly RawIssuerRegistration[] {
  if (validatedRawRegistrations !== null) {
    return validatedRawRegistrations;
  }

  const parsed = rawIssuerRegistrationsSchema.safeParse(rawIssuerRegistrations);

  if (!parsed.success) {
    throw new OidcConfigurationError(
      `invalid OIDC issuer registrations: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }

  validatedRawRegistrations = parsed.data;

  return validatedRawRegistrations;
}

async function materializeIssuerRegistration(
  rawRegistration: RawIssuerRegistration,
  env: Env,
): Promise<IssuerRegistration> {
  const testOverride = validatedTestOverride(env);

  if (
    testOverride !== null &&
    rawRegistration.issuer === "https://token.actions.githubusercontent.com"
  ) {
    return {
      ...baseRegistration(rawRegistration),
      keyId: testOverride.keyId,
      publicKeyPemBase64: testOverride.publicKeyPemBase64,
      source: "static-public-key",
    };
  }

  return {
    ...baseRegistration(rawRegistration),
    jwksUri: rawRegistration.jwksUri,
    source: "remote-jwks",
  };
}

function validatedTestOverride(
  env: Env,
): { keyId: string | null; publicKeyPemBase64: string } | null {
  if (env.TEST_OIDC_STATIC_PUBLIC_KEY_PEM_BASE64 === undefined) {
    return null;
  }

  const parsed = testStaticPublicKeyOverrideSchema.safeParse({
    keyId: env.TEST_OIDC_STATIC_KEY_ID ?? null,
    publicKeyPemBase64: env.TEST_OIDC_STATIC_PUBLIC_KEY_PEM_BASE64,
  });

  if (!parsed.success) {
    throw new OidcConfigurationError(
      `invalid test OIDC key override: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  }

  return parsed.data;
}

function baseRegistration(rawRegistration: RawIssuerRegistration) {
  return {
    allowedAlgorithms: rawRegistration.allowedAlgorithms,
    audience: rawRegistration.audience,
    defaultFreshMs: rawRegistration.defaultFreshMs,
    issuer: rawRegistration.issuer,
    mapPrincipal:
      rawRegistration.principalKind === "github-actions"
        ? mapGitHubActionsPrincipal
        : mapUnsupportedPrincipal,
    maxBackoffMs: rawRegistration.maxBackoffMs,
    maxFreshMs: rawRegistration.maxFreshMs,
    minFreshMs: rawRegistration.minFreshMs,
    principalKind: rawRegistration.principalKind,
    refreshBackoffBaseMs: rawRegistration.refreshBackoffBaseMs,
    requireKid: rawRegistration.requireKid,
    staleWhileErrorMs: rawRegistration.staleWhileErrorMs,
  } as const;
}

function mapUnsupportedPrincipal(): AuthenticatedPrincipal | null {
  return null;
}

function mapGitHubActionsPrincipal(
  payload: Record<string, unknown>,
): GitHubActionsPrincipal | null {
  const eventName = requiredString(payload, "event_name");
  const repository = requiredString(payload, "repository");
  const repositoryId = requiredString(payload, "repository_id");

  if (eventName === null || repository === null || repositoryId === null) {
    return null;
  }

  return {
    actor: optionalString(payload, "actor"),
    eventName,
    ref: optionalString(payload, "ref"),
    repository,
    repositoryId,
    runAttempt: optionalString(payload, "run_attempt"),
    runId: optionalString(payload, "run_id"),
    sha: optionalString(payload, "sha"),
    type: "github-actions",
    workflow: optionalString(payload, "workflow"),
  };
}

function requiredString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];

  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];

  if (value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : null;
}

export async function staticPublicKeyOverrideToJwk(
  publicKeyPemBase64: string,
  keyId: string | null,
): Promise<Record<string, unknown>> {
  const publicKeyPem = Buffer.from(publicKeyPemBase64, "base64").toString("utf8");
  const publicKey = await importSPKI(publicKeyPem, "RS256");
  const exported = await exportJWK(publicKey);
  const jwk: Record<string, unknown> = {
    kty: exported.kty,
  };

  if ("alg" in exported && typeof exported.alg === "string") {
    jwk["alg"] = exported.alg;
  }

  if ("crv" in exported && typeof exported.crv === "string") {
    jwk["crv"] = exported.crv;
  }

  if ("e" in exported && typeof exported.e === "string") {
    jwk["e"] = exported.e;
  }

  if ("n" in exported && typeof exported.n === "string") {
    jwk["n"] = exported.n;
  }

  if ("x" in exported && typeof exported.x === "string") {
    jwk["x"] = exported.x;
  }

  if ("y" in exported && typeof exported.y === "string") {
    jwk["y"] = exported.y;
  }

  if (keyId !== null) {
    jwk["kid"] = keyId;
  }

  return jwk as Record<string, unknown>;
}
