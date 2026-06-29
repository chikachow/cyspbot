import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { isGitHubAppSlug } from "./github-app-audience.ts";

type GitHubInstallationPermissions = Record<string, string>;

export interface InstallationAccessTokenRequest {
  githubAppSlug: string;
  permissions: GitHubInstallationPermissions;
  resource: URL;
  scope: string;
}

export interface TokenPolicyInput {
  principal: GitHubActionsPrincipal;
  tokenRequest: InstallationAccessTokenRequest;
}

export interface TokenPolicyRule {
  githubAppSlug: string;
  permissions: GitHubInstallationPermissions;
  principalEventNames: readonly string[];
  principalRef: string;
  principalRepository: string;
  principalWorkflowRef: string;
  resource: string;
}

interface TokenPolicyAllowDecision {
  decision: "allow";
  matchedRule: TokenPolicyRule;
}

interface TokenPolicyDenyDecision {
  decision: "deny";
  reasons: string[];
}

export type TokenPolicyDecision = TokenPolicyAllowDecision | TokenPolicyDenyDecision;

export interface ParsedGitHubRepositoryResource {
  owner: string;
  repository: string;
  resource: URL;
}

const supportedPermissionScopes = new Map<string, readonly [string, string]>([
  ["actions:read", ["actions", "read"]],
  ["actions:write", ["actions", "write"]],
  ["contents:read", ["contents", "read"]],
  ["contents:write", ["contents", "write"]],
  ["pull_requests:read", ["pull_requests", "read"]],
  ["pull_requests:write", ["pull_requests", "write"]],
]);
const supportedPermissionPairs = new Set(
  [...supportedPermissionScopes.values()].map(permissionPairKey),
);

export function normalizeInstallationAccessTokenRequest(
  principal: GitHubActionsPrincipal,
  options: { githubAppSlug: string; resource: string | null; scope: string | null },
): { ok: true; tokenRequest: InstallationAccessTokenRequest } | { error: string; ok: false } {
  if (!isGitHubAppSlug(options.githubAppSlug)) {
    return { error: "invalid_target", ok: false };
  }

  const resourceValue = options.resource ?? `https://api.github.com/repos/${principal.repository}`;
  const parsedResource = parseGitHubRepositoryResource(resourceValue);

  if (parsedResource === null) {
    return { error: "invalid_target", ok: false };
  }

  const scope = parseGitHubInstallationScope(options.scope ?? "contents:write pull_requests:write");

  if (scope === null) {
    return { error: "invalid_scope", ok: false };
  }

  return {
    ok: true,
    tokenRequest: {
      githubAppSlug: options.githubAppSlug,
      permissions: scope.permissions,
      resource: parsedResource.resource,
      scope: scope.scope,
    },
  };
}

export function evaluateConfiguredTokenPolicy(
  input: TokenPolicyInput,
  rules: readonly TokenPolicyRule[],
): TokenPolicyDecision {
  for (const rule of rules) {
    if (tokenPolicyRuleMatches(rule, input)) {
      return {
        decision: "allow",
        matchedRule: rule,
      };
    }
  }

  return {
    decision: "deny",
    reasons: tokenPolicyDenyReasons(input, rules),
  };
}

export function validateTokenPolicyRules(
  rules: readonly TokenPolicyRule[],
): readonly TokenPolicyRule[] {
  const seen = new Set<string>();

  for (const rule of rules) {
    const key = tokenPolicyRuleKey(rule);

    if (seen.has(key)) {
      throw new Error("duplicate token policy rule");
    }

    const parsedResource = parseGitHubRepositoryResource(rule.resource);

    if (parsedResource === null || parsedResource.resource.href !== rule.resource) {
      throw new Error("invalid token policy rule resource");
    }

    if (rule.principalEventNames.length === 0) {
      throw new Error("invalid token policy rule events");
    }

    if (!isGitHubAppSlug(rule.githubAppSlug)) {
      throw new Error("invalid token policy rule github app");
    }

    if (!rulePermissionsAreSupported(rule.permissions)) {
      throw new Error("invalid token policy rule permissions");
    }

    seen.add(key);
  }

  return rules;
}

export function parseGitHubRepositoryResource(
  value: string,
): ParsedGitHubRepositoryResource | null {
  if (value.length === 0) {
    return null;
  }

  let resource: URL;

  try {
    resource = new URL(value);
  } catch {
    return null;
  }

  if (
    resource.href !== value ||
    resource.protocol !== "https:" ||
    resource.hostname !== "api.github.com" ||
    resource.port.length !== 0 ||
    resource.username.length !== 0 ||
    resource.password.length !== 0 ||
    resource.search.length !== 0 ||
    resource.hash.length !== 0
  ) {
    return null;
  }

  const parts = resource.pathname.split("/");

  if (
    parts.length !== 4 ||
    parts[0] !== "" ||
    parts[1] !== "repos" ||
    !isGitHubPathSegment(parts[2]) ||
    !isGitHubPathSegment(parts[3])
  ) {
    return null;
  }

  return {
    owner: parts[2],
    repository: parts[3],
    resource,
  };
}

function tokenPolicyRuleMatches(rule: TokenPolicyRule, input: TokenPolicyInput): boolean {
  const { principal, tokenRequest } = input;

  return (
    principal.repository === rule.principalRepository &&
    rule.principalEventNames.includes(principal.eventName) &&
    principal.refType === "branch" &&
    principal.ref === rule.principalRef &&
    principal.subject.kind === "ref" &&
    principal.subject.ref === rule.principalRef &&
    principal.workflowRef === rule.principalWorkflowRef &&
    tokenRequest.githubAppSlug === rule.githubAppSlug &&
    tokenRequest.resource.href === rule.resource &&
    permissionsEqual(tokenRequest.permissions, rule.permissions)
  );
}

function tokenPolicyDenyReasons(
  input: TokenPolicyInput,
  rules: readonly TokenPolicyRule[],
): string[] {
  const { principal, tokenRequest } = input;
  const reasons: string[] = [];
  const repositoryRules = rules.filter((rule) => rule.principalRepository === principal.repository);

  if (repositoryRules.length === 0) {
    reasons.push("repository");
  }

  const eventRules = repositoryRules.filter((rule) =>
    rule.principalEventNames.includes(principal.eventName),
  );

  if (repositoryRules.length > 0 && eventRules.length === 0) {
    reasons.push("event_name");
  }

  if (principal.refType !== "branch") {
    reasons.push("ref_type");
  }

  if (principal.subject.kind !== "ref") {
    reasons.push("sub");
  }

  const refRules = eventRules.filter(
    (rule) =>
      principal.ref === rule.principalRef &&
      principal.subject.kind === "ref" &&
      principal.subject.ref === rule.principalRef,
  );

  if (eventRules.length > 0 && refRules.length === 0) {
    if (principal.ref === null || eventRules.every((rule) => principal.ref !== rule.principalRef)) {
      reasons.push("ref");
    }

    if (
      principal.subject.kind !== "ref" ||
      eventRules.every(
        (rule) => principal.subject.kind === "ref" && principal.subject.ref !== rule.principalRef,
      )
    ) {
      reasons.push("sub");
    }
  }

  const workflowRules = refRules.filter(
    (rule) => principal.workflowRef === rule.principalWorkflowRef,
  );

  if (refRules.length > 0 && workflowRules.length === 0) {
    reasons.push("workflow_ref");
  }

  const githubAppRules = workflowRules.filter(
    (rule) => tokenRequest.githubAppSlug === rule.githubAppSlug,
  );

  if (workflowRules.length > 0 && githubAppRules.length === 0) {
    reasons.push("github_app");
  }

  const resourceRules = githubAppRules.filter(
    (rule) => tokenRequest.resource.href === rule.resource,
  );

  if (githubAppRules.length > 0 && resourceRules.length === 0) {
    reasons.push("resource");
  }

  if (
    resourceRules.length > 0 &&
    resourceRules.every((rule) => !permissionsEqual(tokenRequest.permissions, rule.permissions))
  ) {
    reasons.push("permissions");
  }

  return [...new Set(reasons.length === 0 ? ["token_policy_rule"] : reasons)];
}

function parseGitHubInstallationScope(
  value: string,
): { permissions: GitHubInstallationPermissions; scope: string } | null {
  const scopeTokens = value.split(" ");

  if (scopeTokens.some((scope) => scope.length === 0)) {
    return null;
  }

  const permissions: GitHubInstallationPermissions = {};
  const seen = new Set<string>();

  for (const scope of scopeTokens) {
    const permission = supportedPermissionScopes.get(scope);

    if (permission === undefined || seen.has(scope)) {
      return null;
    }

    const [name, level] = permission;

    if (permissions[name] !== undefined) {
      return null;
    }

    permissions[name] = level;
    seen.add(scope);
  }

  return {
    permissions,
    scope: [...seen].sort().join(" "),
  };
}

function permissionsEqual(
  left: GitHubInstallationPermissions,
  right: GitHubInstallationPermissions,
): boolean {
  const leftEntries = Object.entries(left).sort(comparePermissionEntry);
  const rightEntries = Object.entries(right).sort(comparePermissionEntry);

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([leftName, leftLevel], index) => {
      const [rightName, rightLevel] = rightEntries[index] ?? [];

      return leftName === rightName && leftLevel === rightLevel;
    })
  );
}

function tokenPolicyRuleKey(rule: TokenPolicyRule): string {
  return JSON.stringify({
    githubAppSlug: rule.githubAppSlug,
    permissions: Object.fromEntries(Object.entries(rule.permissions).sort(comparePermissionEntry)),
    principalEventNames: [...rule.principalEventNames].sort(),
    principalRef: rule.principalRef,
    principalRepository: rule.principalRepository,
    principalWorkflowRef: rule.principalWorkflowRef,
    resource: rule.resource,
  });
}

function comparePermissionEntry(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left.localeCompare(right);
}

function rulePermissionsAreSupported(permissions: GitHubInstallationPermissions): boolean {
  const entries = Object.entries(permissions);

  return (
    entries.length > 0 &&
    entries.every(([name, level]) => supportedPermissionPairs.has(permissionPairKey([name, level])))
  );
}

function permissionPairKey([name, level]: readonly [string, string]): string {
  return JSON.stringify([name, level]);
}

function isGitHubPathSegment(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_.-]+$/u.test(value);
}
