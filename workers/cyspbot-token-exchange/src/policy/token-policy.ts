import { githubActionsTrustedIssuer } from "@cyspbot/oidc-issuer-github-actions";
import type { VerifiedSubjectToken } from "../authentication.ts";
import {
  tokenPolicyConditionIsValid,
  tokenPolicyConditionMatches,
} from "./token-policy-condition.ts";

type GitHubInstallationPermissions = Record<string, string>;

export interface InstallationAccessTokenRequest {
  permissions: GitHubInstallationPermissions;
  resource: URL;
  scope: string;
}

export interface TokenPolicyInput {
  subjectToken: VerifiedSubjectToken;
  tokenRequest: InstallationAccessTokenRequest;
}

export interface TokenPolicyRule {
  effect: "allow";
  id: string;
  issue: {
    githubInstallationToken: {
      permissions: GitHubInstallationPermissions;
      resource: string;
    };
  };
  subject: {
    issuer: string;
  };
  when: string;
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

const maxCelConditionLength = 4096;
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
  subjectToken: VerifiedSubjectToken,
  options: { resource: string | null; scope: string | null },
): { ok: true; tokenRequest: InstallationAccessTokenRequest } | { error: string; ok: false } {
  const normalizedResource = normalizeInstallationAccessTokenResource(
    subjectToken,
    options.resource,
  );

  if (!normalizedResource.ok) {
    return { error: normalizedResource.error, ok: false };
  }

  const scope = parseGitHubInstallationScope(options.scope ?? "contents:write pull_requests:write");

  if (scope === null) {
    return { error: "invalid_scope", ok: false };
  }

  return {
    ok: true,
    tokenRequest: {
      permissions: scope.permissions,
      resource: normalizedResource.resource,
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
  const seenIds = new Set<string>();
  const seenEffectiveGrants = new Set<string>();

  for (const rule of rules) {
    if (!requiredRuleFieldsArePresent(rule.id, rule.subject.issuer)) {
      throw new Error("invalid token policy rule id");
    }

    if (seenIds.has(rule.id)) {
      throw new Error("duplicate token policy rule id");
    }

    if (rule.effect !== "allow") {
      throw new Error("invalid token policy rule effect");
    }

    const parsedResource = parseGitHubRepositoryResource(
      rule.issue.githubInstallationToken.resource,
    );

    if (
      parsedResource === null ||
      parsedResource.resource.href !== rule.issue.githubInstallationToken.resource
    ) {
      throw new Error("invalid token policy rule resource");
    }

    if (!rulePermissionsAreSupported(rule.issue.githubInstallationToken.permissions)) {
      throw new Error("invalid token policy rule permissions");
    }

    if (rule.when.length === 0 || rule.when.length > maxCelConditionLength) {
      throw new Error("invalid token policy rule condition");
    }

    if (!tokenPolicyConditionIsValid(rule)) {
      throw new Error("invalid token policy rule condition");
    }

    const effectiveGrantKey = tokenPolicyRuleEffectiveGrantKey(rule);

    if (seenEffectiveGrants.has(effectiveGrantKey)) {
      throw new Error("duplicate token policy rule");
    }

    seenIds.add(rule.id);
    seenEffectiveGrants.add(effectiveGrantKey);
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

function normalizeInstallationAccessTokenResource(
  subjectToken: VerifiedSubjectToken,
  resource: string | null,
):
  | {
      ok: true;
      resource: URL;
    }
  | { error: string; ok: false } {
  if (resource !== null) {
    const parsedResource = parseGitHubRepositoryResource(resource);

    return parsedResource === null
      ? { error: "invalid_target", ok: false }
      : { ok: true, resource: parsedResource.resource };
  }

  const repository = subjectToken.claims["repository"];

  if (
    subjectToken.issuer !== githubActionsTrustedIssuer.issuer ||
    typeof repository !== "string" ||
    repository.length === 0
  ) {
    return { error: "invalid_target", ok: false };
  }

  const parsedResource = parseGitHubRepositoryResource(
    `https://api.github.com/repos/${repository}`,
  );

  return parsedResource === null
    ? { error: "invalid_target", ok: false }
    : { ok: true, resource: parsedResource.resource };
}

function tokenPolicyRuleMatches(rule: TokenPolicyRule, input: TokenPolicyInput): boolean {
  const grant = rule.issue.githubInstallationToken;

  return (
    input.subjectToken.issuer === rule.subject.issuer &&
    input.tokenRequest.resource.href === grant.resource &&
    permissionsEqual(input.tokenRequest.permissions, grant.permissions) &&
    tokenPolicyConditionMatches(rule, input)
  );
}

function tokenPolicyDenyReasons(
  input: TokenPolicyInput,
  rules: readonly TokenPolicyRule[],
): string[] {
  const resourceRules = rules.filter(
    (rule) => input.tokenRequest.resource.href === rule.issue.githubInstallationToken.resource,
  );
  const reasons: string[] = [];

  if (resourceRules.length === 0) {
    reasons.push("resource");
  }

  const issuerRules = resourceRules.filter(
    (rule) => input.subjectToken.issuer === rule.subject.issuer,
  );

  if (resourceRules.length > 0 && issuerRules.length === 0) {
    reasons.push("subject_issuer");
  }

  const permissionRules = issuerRules.filter((rule) =>
    permissionsEqual(
      input.tokenRequest.permissions,
      rule.issue.githubInstallationToken.permissions,
    ),
  );

  if (issuerRules.length > 0 && permissionRules.length === 0) {
    reasons.push("permissions");
  }

  if (
    permissionRules.length > 0 &&
    permissionRules.every((rule) => !tokenPolicyConditionMatches(rule, input))
  ) {
    reasons.push("condition");
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

function tokenPolicyRuleEffectiveGrantKey(rule: TokenPolicyRule): string {
  return JSON.stringify({
    issue: {
      githubInstallationToken: {
        permissions: Object.fromEntries(
          Object.entries(rule.issue.githubInstallationToken.permissions).sort(
            comparePermissionEntry,
          ),
        ),
        resource: rule.issue.githubInstallationToken.resource,
      },
    },
    subject: rule.subject,
    when: rule.when,
  });
}

function comparePermissionEntry(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left.localeCompare(right);
}

function requiredRuleFieldsArePresent(...values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value.length > 0);
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
