import type { GitHubRepository } from "@cyspbot/github/app";
import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";

export type TokenPolicyRepository = Pick<
  GitHubRepository,
  "defaultBranch" | "repository" | "repositoryId" | "repositoryOwnerId" | "repositoryVisibility"
>;

export interface TokenPolicyAllowDecision {
  decision: "allow";
  permissions: Record<string, string>;
  reasons: string[];
}

interface TokenPolicyDenyDecision {
  decision: "deny";
  reasons: string[];
}

export type TokenPolicyDecision = TokenPolicyAllowDecision | TokenPolicyDenyDecision;

const allowedEventNames = new Set(["schedule", "workflow_dispatch"]);

export function evaluateTokenPolicyPreflight(
  principal: GitHubActionsPrincipal,
): TokenPolicyDecision {
  const reasons = evaluateTokenPolicyPreflightReasons(principal);

  if (reasons.length > 0) {
    return {
      decision: "deny",
      reasons,
    };
  }

  return {
    decision: "allow",
    permissions: installationTokenPermissions(),
    reasons: [],
  };
}

export function evaluateTokenPolicy(
  principal: GitHubActionsPrincipal,
  repository: TokenPolicyRepository,
): TokenPolicyDecision {
  const reasons = evaluateTokenPolicyPreflightReasons(principal);
  const defaultBranchRef = `refs/heads/${repository.defaultBranch}`;

  if (principal.repositoryId !== repository.repositoryId) {
    reasons.push("repository_id");
  }

  if (principal.repository !== repository.repository) {
    reasons.push("repository");
  }

  if (principal.repositoryOwnerId !== repository.repositoryOwnerId) {
    reasons.push("repository_owner_id");
  }

  if (principal.repositoryVisibility !== repository.repositoryVisibility) {
    reasons.push("repository_visibility");
  }

  switch (principal.subject.kind) {
    case "environment":
    case "pull_request":
      break;

    case "ref":
      if (principal.subject.ref !== defaultBranchRef) {
        reasons.push("sub");
      }
      break;

    default: {
      const exhaustive: never = principal.subject;
      return exhaustive;
    }
  }

  if (principal.ref !== defaultBranchRef) {
    reasons.push("ref");
  }

  const uniqueReasons = [...new Set(reasons)];

  if (uniqueReasons.length > 0) {
    return {
      decision: "deny",
      reasons: uniqueReasons,
    };
  }

  return {
    decision: "allow",
    permissions: installationTokenPermissions(),
    reasons: [],
  };
}

function evaluateTokenPolicyPreflightReasons(principal: GitHubActionsPrincipal): string[] {
  const reasons: string[] = [];

  if (!allowedEventNames.has(principal.eventName)) {
    reasons.push("event_name");
  }

  switch (principal.subject.kind) {
    case "environment":
    case "pull_request":
      reasons.push("sub");
      break;

    case "ref":
      break;

    default: {
      const exhaustive: never = principal.subject;
      return exhaustive;
    }
  }

  if (principal.refType !== "branch") {
    reasons.push("ref_type");
  }

  return [...new Set(reasons)];
}

function installationTokenPermissions(): Record<string, string> {
  return {
    contents: "write",
    pull_requests: "write",
  };
}
