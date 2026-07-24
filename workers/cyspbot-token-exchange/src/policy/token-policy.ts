import type { VerifiedSubjectToken } from "../authentication.ts";
import {
  canonicalizeInstallationAccessTokenPermissions,
  installationAccessTokenPermissionsAreSupported,
  installationAccessTokenPermissionsEqual,
  parseGitHubRepositoryResource,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
} from "./installation-token-request.ts";
import {
  tokenPolicyConditionIsValid,
  tokenPolicyConditionMatches,
} from "./token-policy-condition.ts";

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

    if (
      !installationAccessTokenPermissionsAreSupported(
        rule.issue.githubInstallationToken.permissions,
      )
    ) {
      throw new Error("invalid token policy rule permissions");
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

function tokenPolicyRuleMatches(rule: TokenPolicyRule, input: TokenPolicyInput): boolean {
  const grant = rule.issue.githubInstallationToken;

  return (
    input.subjectToken.issuer === rule.subject.issuer &&
    input.tokenRequest.resource.href === grant.resource &&
    installationAccessTokenPermissionsEqual(input.tokenRequest.permissions, grant.permissions) &&
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
    installationAccessTokenPermissionsEqual(
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

function tokenPolicyRuleEffectiveGrantKey(rule: TokenPolicyRule): string {
  return JSON.stringify({
    issue: {
      githubInstallationToken: {
        permissions: canonicalizeInstallationAccessTokenPermissions(
          rule.issue.githubInstallationToken.permissions,
        ),
        resource: rule.issue.githubInstallationToken.resource,
      },
    },
    subject: rule.subject,
    when: rule.when,
  });
}

function requiredRuleFieldsArePresent(...values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value.length > 0);
}
