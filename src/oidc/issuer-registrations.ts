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
  const subject = requiredString(payload, "sub");

  if (eventName === null || repository === null || repositoryId === null || subject === null) {
    return null;
  }

  const parsedSubject = parseGitHubOidcSubject(subject);
  const ref = optionalString(payload, "ref");

  return {
    actor: optionalString(payload, "actor"),
    baseRef: optionalString(payload, "base_ref"),
    environment: optionalString(payload, "environment"),
    eventName,
    headRef: optionalString(payload, "head_ref"),
    jobWorkflowRef: optionalString(payload, "job_workflow_ref"),
    rawSubject: subject,
    ref,
    refType: optionalString(payload, "ref_type") ?? inferRefType(ref),
    repository,
    repositoryId,
    repositoryOwnerId: optionalString(payload, "repository_owner_id"),
    repositoryVisibility: optionalString(payload, "repository_visibility"),
    runAttempt: optionalString(payload, "run_attempt"),
    runId: optionalString(payload, "run_id"),
    sha: optionalString(payload, "sha"),
    subjectContextKind: parsedSubject.contextKind,
    subjectContextValue: parsedSubject.contextValue,
    subjectRepository: parsedSubject.repository,
    type: "github-actions",
    workflow: optionalString(payload, "workflow"),
    workflowRef: optionalString(payload, "workflow_ref"),
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

function parseGitHubOidcSubject(subject: string): {
  contextKind: string | null;
  contextValue: string | null;
  repository: string | null;
} {
  const match = /^repo:([^:]+):([^:]+)(?::(.+))?$/u.exec(subject);

  if (match === null) {
    return {
      contextKind: null,
      contextValue: null,
      repository: null,
    };
  }

  const [, repository, contextKind, rawContextValue] = match;

  return {
    contextKind: contextKind ?? null,
    contextValue:
      rawContextValue === undefined ? null : safeDecodeSubjectComponent(rawContextValue),
    repository: repository === undefined ? null : safeDecodeSubjectComponent(repository),
  };
}

function inferRefType(ref: string | null): string | null {
  if (ref === null) {
    return null;
  }

  if (ref.startsWith("refs/heads/")) {
    return "branch";
  }

  if (ref.startsWith("refs/tags/")) {
    return "tag";
  }

  if (ref.startsWith("refs/pull/")) {
    return "pull_request";
  }

  return null;
}

function safeDecodeSubjectComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
