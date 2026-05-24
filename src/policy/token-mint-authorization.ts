import type { GitHubActionsPrincipal } from "../oidc/principals.ts";

export interface TokenMintAuthorizationRepository {
  defaultBranch: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  repositoryVisibility: string;
}

export interface TokenMintAllowPolicyDecision {
  decision: "allow";
  eventType: string;
  permissions: Record<string, string>;
  reasons: string[];
}

export interface TokenMintDenyPolicyDecision {
  decision: "deny";
  eventType: string;
  reasons: string[];
}

export type TokenMintPolicyDecision = TokenMintAllowPolicyDecision | TokenMintDenyPolicyDecision;

export function evaluateTokenMintPolicy(
  principal: GitHubActionsPrincipal,
  repository: TokenMintAuthorizationRepository,
): TokenMintPolicyDecision {
  const reasons: string[] = [];

  if (principal.eventName === "pull_request" || principal.eventName === "pull_request_target") {
    reasons.push("event_not_allowed");
  }

  if (principal.subjectContextKind === "pull_request") {
    reasons.push("subject_context_not_allowed");
  }

  if (principal.eventName !== "schedule" && principal.eventName !== "workflow_dispatch") {
    reasons.push("event_not_allowed");
  }

  if (principal.repositoryId !== repository.repositoryId) {
    reasons.push("repository_id_mismatch");
  }

  if (principal.repository !== repository.repository) {
    reasons.push("repository_mismatch");
  }

  if (principal.repositoryOwnerId !== repository.repositoryOwnerId) {
    reasons.push("repository_owner_id_mismatch");
  }

  if (principal.repositoryVisibility !== repository.repositoryVisibility) {
    reasons.push("repository_visibility_mismatch");
  }

  if (principal.subjectRepository !== repository.repository) {
    reasons.push("subject_repository_mismatch");
  }

  if (principal.subjectContextKind !== "ref") {
    reasons.push("subject_context_kind_mismatch");
  }

  if (principal.subjectContextValue !== `refs/heads/${repository.defaultBranch}`) {
    reasons.push("subject_context_value_mismatch");
  }

  if (principal.ref !== `refs/heads/${repository.defaultBranch}`) {
    reasons.push("ref_mismatch");
  }

  if (principal.refType !== "branch") {
    reasons.push("ref_type_mismatch");
  }

  const uniqueReasons = [...new Set(reasons)];

  if (uniqueReasons.length > 0) {
    return {
      decision: "deny",
      eventType: principal.eventName,
      reasons: uniqueReasons,
    };
  }

  return {
    decision: "allow",
    eventType: principal.eventName,
    permissions: {
      contents: "write",
      pull_requests: "write",
    },
    reasons: [],
  };
}
