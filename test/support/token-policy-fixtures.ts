import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import {
  normalizeInstallationAccessTokenRequest,
  type InstallationAccessTokenRequest,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";

export const fixtureRef = "refs/heads/fixture-base-branch";
export const fixtureSourceRepository = "fixture-owner/fixture-source-repository";
const fixtureWorkflowRef = `${fixtureSourceRepository}/.github/workflows/fixture-token-request.yml@${fixtureRef}`;
export const fixtureSourceResource = `https://api.github.com/repos/${fixtureSourceRepository}`;
export const fixtureTargetResource =
  "https://api.github.com/repos/fixture-target-owner/fixture-target-repository";

export const principal: GitHubActionsPrincipal = {
  actor: "dependabot[bot]",
  eventName: "workflow_dispatch",
  rawSubject: `repo:${fixtureSourceRepository}:ref:${fixtureRef}`,
  ref: fixtureRef,
  refType: "branch",
  repository: fixtureSourceRepository,
  repositoryId: "123456789",
  repositoryOwnerId: "555555",
  repositoryVisibility: "private",
  runAttempt: "1",
  runId: "987654321",
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: {
    kind: "ref",
    raw: `repo:${fixtureSourceRepository}:ref:${fixtureRef}`,
    ref: fixtureRef,
    repositorySubject: fixtureSourceRepository,
  },
  workflow: "fixture token request",
  workflowRef: fixtureWorkflowRef,
};

export function sameRepositoryTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest(principal, {
    resource: null,
    scope: null,
  });
}

export function crossOwnerActionsTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest(principal, {
    resource: fixtureTargetResource,
    scope: "actions:write",
  });
}

export function mustNormalizeTokenRequest(
  testPrincipal: GitHubActionsPrincipal,
  options: { githubAppSlug?: string; resource: string | null; scope: string | null },
): InstallationAccessTokenRequest {
  const result = normalizeInstallationAccessTokenRequest(testPrincipal, {
    githubAppSlug: options.githubAppSlug ?? "cyspbot",
    resource: options.resource,
    scope: options.scope,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.tokenRequest;
}

export function principalWithRef(ref: string): GitHubActionsPrincipal {
  const rawSubject = `repo:${fixtureSourceRepository}:ref:${ref}`;

  return {
    ...principal,
    rawSubject,
    ref,
    subject: {
      kind: "ref",
      raw: rawSubject,
      ref,
      repositorySubject: fixtureSourceRepository,
    },
  };
}

export function unconfiguredWorkflowRef(): string {
  return `${fixtureSourceRepository}/.github/workflows/fixture-unconfigured.yml@${fixtureRef}`;
}

export function principalForRule(
  rule: TokenPolicyRule,
  eventName = requiredFirstEventName(rule),
  ref = rule.principalRef,
): GitHubActionsPrincipal {
  const rawSubject = `repo:${rule.principalRepository}:ref:${ref}`;

  return {
    actor: "fixture-production-rule-actor",
    eventName,
    rawSubject,
    ref,
    refType: "branch",
    repository: rule.principalRepository,
    repositoryId: "123456789",
    repositoryOwnerId: "555555",
    repositoryVisibility: "private",
    runAttempt: "1",
    runId: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    subject: {
      kind: "ref",
      raw: rawSubject,
      ref,
      repositorySubject: rule.principalRepository,
    },
    workflow: "fixture production rule workflow",
    workflowRef: rule.principalWorkflowRef,
  };
}

export function tokenRequestForRule(rule: TokenPolicyRule): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest(principalForRule(rule), {
    githubAppSlug: rule.githubAppSlug,
    resource: rule.resource,
    scope: scopeForPermissions(rule.permissions),
  });
}

function scopeForPermissions(permissions: Record<string, string>): string {
  return Object.entries(permissions)
    .map(([name, level]) => {
      const scope = permissionScopeForRulePermission(name, level);

      if (scope === null) {
        throw new Error(`unsupported token policy rule permission: ${name}:${level}`);
      }

      return scope;
    })
    .sort()
    .join(" ");
}

function permissionScopeForRulePermission(name: string, level: string): string | null {
  if (name === "actions" && level === "write") {
    return "actions:write";
  }

  if (name === "contents" && level === "write") {
    return "contents:write";
  }

  if (name === "pull_requests" && level === "write") {
    return "pull_requests:write";
  }

  return null;
}

function requiredFirstEventName(rule: TokenPolicyRule): string {
  const eventName = rule.principalEventNames[0];

  if (eventName === undefined) {
    throw new Error("production token policy rule must contain at least one event");
  }

  return eventName;
}
