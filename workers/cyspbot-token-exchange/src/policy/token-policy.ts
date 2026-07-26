import type { VerifiedSubjectToken } from "../authentication.ts";
import {
  parseOidcIssuerIdentifier,
  type OidcIssuerIdentifier,
} from "@cyspbot/oidc/provider-registration";
import {
  canonicalizeInstallationAccessTokenPermissions,
  installationAccessTokenPermissionsAreSupported,
  installationAccessTokenPermissionsEqual,
  parseGitHubRepositoryResource,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
} from "../installation-access-token-request.ts";
import {
  tokenPolicyConditionIsValid,
  tokenPolicyConditionMatches,
} from "./token-policy-condition.ts";

export interface TokenPolicyInput {
  verifiedSubjectToken: VerifiedSubjectToken;
  tokenRequest: InstallationAccessTokenRequest;
}

interface TokenPolicyRuleShape<Issuer extends string> {
  effect: "allow";
  id: string;
  issue: {
    githubInstallationAccessToken: {
      permissions: GitHubInstallationPermissions;
      resource: string;
    };
  };
  subject: {
    issuer: Issuer;
  };
  when: string;
}

export type TokenPolicyRuleDefinition = TokenPolicyRuleShape<string>;
export type TokenPolicyRule = TokenPolicyRuleShape<OidcIssuerIdentifier>;

declare const validatedTokenPolicy: unique symbol;

export type TokenPolicy = readonly TokenPolicyRule[] & {
  readonly [validatedTokenPolicy]: true;
};

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
  rules: TokenPolicy,
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
  definitions: readonly TokenPolicyRuleDefinition[],
): TokenPolicy {
  const seenIds = new Set<string>();
  const seenEffectiveGrants = new Set<string>();
  const rules: TokenPolicyRule[] = [];

  for (const definition of definitions) {
    if (typeof definition.id !== "string" || definition.id.length === 0) {
      throw new Error("invalid token policy rule id");
    }

    if (seenIds.has(definition.id)) {
      throw new Error("duplicate token policy rule id");
    }

    if (definition.effect !== "allow") {
      throw new Error("invalid token policy rule effect");
    }

    const issuer =
      typeof definition.subject?.issuer === "string"
        ? parseOidcIssuerIdentifier(definition.subject.issuer)
        : null;

    if (issuer === null) {
      throw new Error("invalid token policy rule OIDC Issuer Identifier");
    }

    const parsedResource = parseGitHubRepositoryResource(
      definition.issue.githubInstallationAccessToken.resource,
    );

    if (
      parsedResource === null ||
      parsedResource.href !== definition.issue.githubInstallationAccessToken.resource
    ) {
      throw new Error("invalid token policy rule resource");
    }

    if (
      !installationAccessTokenPermissionsAreSupported(
        definition.issue.githubInstallationAccessToken.permissions,
      )
    ) {
      throw new Error("invalid token policy rule permissions");
    }

    const rule: TokenPolicyRule = Object.freeze({
      effect: definition.effect,
      id: definition.id,
      issue: Object.freeze({
        githubInstallationAccessToken: Object.freeze({
          permissions: Object.freeze({
            ...definition.issue.githubInstallationAccessToken.permissions,
          }),
          resource: definition.issue.githubInstallationAccessToken.resource,
        }),
      }),
      subject: Object.freeze({ issuer }),
      when: definition.when,
    });

    if (!tokenPolicyConditionIsValid(rule)) {
      throw new Error("invalid token policy rule condition");
    }

    const effectiveGrantKey = tokenPolicyRuleEffectiveGrantKey(rule);

    if (seenEffectiveGrants.has(effectiveGrantKey)) {
      throw new Error("duplicate token policy rule");
    }

    seenIds.add(definition.id);
    seenEffectiveGrants.add(effectiveGrantKey);
    rules.push(rule);
  }

  return Object.freeze(rules) as TokenPolicy;
}

function tokenPolicyRuleMatches(rule: TokenPolicyRule, input: TokenPolicyInput): boolean {
  const grant = rule.issue.githubInstallationAccessToken;

  return (
    input.verifiedSubjectToken.issuer === rule.subject.issuer &&
    input.tokenRequest.resource.href === grant.resource &&
    installationAccessTokenPermissionsEqual(input.tokenRequest.permissions, grant.permissions) &&
    tokenPolicyConditionMatches(rule, input.verifiedSubjectToken)
  );
}

function tokenPolicyDenyReasons(
  input: TokenPolicyInput,
  rules: readonly TokenPolicyRule[],
): string[] {
  const resourceRules = rules.filter(
    (rule) =>
      input.tokenRequest.resource.href === rule.issue.githubInstallationAccessToken.resource,
  );
  const reasons: string[] = [];

  if (resourceRules.length === 0) {
    reasons.push("resource");
  }

  const issuerRules = resourceRules.filter(
    (rule) => input.verifiedSubjectToken.issuer === rule.subject.issuer,
  );

  if (resourceRules.length > 0 && issuerRules.length === 0) {
    reasons.push("subject_issuer");
  }

  const permissionRules = issuerRules.filter((rule) =>
    installationAccessTokenPermissionsEqual(
      input.tokenRequest.permissions,
      rule.issue.githubInstallationAccessToken.permissions,
    ),
  );

  if (issuerRules.length > 0 && permissionRules.length === 0) {
    reasons.push("permissions");
  }

  if (
    permissionRules.length > 0 &&
    permissionRules.every((rule) => !tokenPolicyConditionMatches(rule, input.verifiedSubjectToken))
  ) {
    reasons.push("condition");
  }

  return [...new Set(reasons.length === 0 ? ["token_policy_rule"] : reasons)];
}

function tokenPolicyRuleEffectiveGrantKey(rule: TokenPolicyRuleDefinition): string {
  return JSON.stringify({
    issue: {
      githubInstallationAccessToken: {
        permissions: canonicalizeInstallationAccessTokenPermissions(
          rule.issue.githubInstallationAccessToken.permissions,
        ),
        resource: rule.issue.githubInstallationAccessToken.resource,
      },
    },
    subject: rule.subject,
    when: rule.when,
  });
}
