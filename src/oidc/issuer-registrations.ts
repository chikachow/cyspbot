import type { Env } from "../env.ts";
import type { RawIssuerRegistration } from "./config-schema.ts";
import { rawIssuerRegistrationsSchema } from "./config-schema.ts";
import { rawIssuerRegistrations } from "./issuer-registrations-config.ts";
import type {
  AuthenticatedPrincipal,
  GitHubActionsPrincipal,
  IssuerRegistration,
} from "./principals.ts";

let validatedRawRegistrations: readonly RawIssuerRegistration[] | null = null;

export class OidcConfigurationError extends Error {}

export function loadIssuerRegistrationByIssuer(
  env: Env,
  issuer: string,
): IssuerRegistration | null {
  const rawRegistration = validatedRawIssuerRegistrations().find(
    (registration) => registration.issuer === issuer,
  );

  if (rawRegistration === undefined) {
    return null;
  }

  return {
    allowedAlgorithms: rawRegistration.allowedAlgorithms,
    audience: rawRegistration.audience,
    defaultFreshMs: rawRegistration.defaultFreshMs,
    issuer: rawRegistration.issuer,
    jwksUri:
      rawRegistration.issuer === "https://token.actions.githubusercontent.com" &&
      env.TEST_OIDC_JWKS_URI !== undefined
        ? env.TEST_OIDC_JWKS_URI
        : rawRegistration.jwksUri,
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
  };
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
