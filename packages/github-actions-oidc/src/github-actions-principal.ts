import { z } from "zod/v4";

import type { VerifiedOidcToken } from "@cyspbot/oidc";
import type { GitHubActionsPrincipal, GitHubActionsSubject } from "./principals.ts";

const optionalStringClaim = z.string().nullable().optional();
const requiredStringClaim = z.string().min(1);

const githubActionsClaimsSchema = z.object({
  actor: optionalStringClaim,
  base_ref: optionalStringClaim,
  environment: optionalStringClaim,
  event_name: requiredStringClaim,
  head_ref: optionalStringClaim,
  job_workflow_ref: optionalStringClaim,
  ref: optionalStringClaim,
  ref_type: requiredStringClaim,
  repository: requiredStringClaim,
  repository_id: requiredStringClaim,
  repository_owner_id: optionalStringClaim,
  repository_visibility: optionalStringClaim,
  run_attempt: optionalStringClaim,
  run_id: optionalStringClaim,
  sha: optionalStringClaim,
  sub: requiredStringClaim,
  workflow: optionalStringClaim,
  workflow_ref: optionalStringClaim,
});

export type GitHubActionsClaims = z.output<typeof githubActionsClaimsSchema>;

export function parseGitHubActionsClaims(
  claims: VerifiedOidcToken["claims"],
): GitHubActionsClaims | null {
  const parsedClaims = githubActionsClaimsSchema.safeParse(claims);

  if (!parsedClaims.success) {
    return null;
  }

  return parsedClaims.data;
}

export function deriveGitHubActionsPrincipal(
  claims: GitHubActionsClaims,
): GitHubActionsPrincipal | null {
  const parsedSubject = parseGitHubOidcSubject(claims.sub);
  if (parsedSubject === null) {
    return null;
  }

  return {
    actor: claims.actor ?? null,
    eventName: claims.event_name,
    jobWorkflowRef: claims.job_workflow_ref ?? null,
    rawSubject: claims.sub,
    ref: claims.ref ?? null,
    refType: claims.ref_type,
    repository: claims.repository,
    repositoryId: claims.repository_id,
    repositoryOwnerId: claims.repository_owner_id ?? null,
    repositoryVisibility: claims.repository_visibility ?? null,
    runAttempt: claims.run_attempt ?? null,
    runId: claims.run_id ?? null,
    sha: claims.sha ?? null,
    subject: parsedSubject,
    workflow: claims.workflow ?? null,
    workflowRef: claims.workflow_ref ?? null,
  };
}

function parseGitHubOidcSubject(subject: string): GitHubActionsSubject | null {
  const match = /^repo:([^:]+):([^:]+)(?::(.+))?$/u.exec(subject);

  if (match === null) {
    return null;
  }

  const [, repository, contextKind, rawContextValue] = match;
  const decodedRepository = decodeSubjectComponent(repository);

  if (decodedRepository === null || decodedRepository.length === 0) {
    return null;
  }

  switch (contextKind) {
    case "environment": {
      const environment = decodeRequiredSubjectComponent(rawContextValue);

      return environment === null
        ? null
        : {
            environment,
            kind: "environment",
            raw: subject,
            repositorySubject: decodedRepository,
          };
    }

    case "pull_request":
      return rawContextValue === undefined
        ? {
            kind: "pull_request",
            raw: subject,
            repositorySubject: decodedRepository,
          }
        : null;

    case "ref": {
      const ref = decodeRequiredSubjectComponent(rawContextValue);

      return ref === null
        ? null
        : {
            kind: "ref",
            raw: subject,
            ref,
            repositorySubject: decodedRepository,
          };
    }

    default:
      return null;
  }
}

function decodeSubjectComponent(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodeRequiredSubjectComponent(value: string | undefined): string | null {
  const decoded = decodeSubjectComponent(value);

  return decoded === null || decoded.length === 0 ? null : decoded;
}
