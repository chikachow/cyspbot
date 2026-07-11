import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  validateTokenPolicyRules,
  type InstallationAccessTokenRequest,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import { tokenPolicyRules as productionTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy-rules";
import { subjectTokenForRule } from "./support/token-policy-fixtures.ts";

describe("Production Token Policy rules", () => {
  it("contains checked-in rules", () => {
    expect(productionTokenPolicyRules.length).toBeGreaterThan(0);
  });

  it("has valid checked-in rules", () => {
    expect(validateTokenPolicyRules(productionTokenPolicyRules)).toBe(productionTokenPolicyRules);
  });

  it.each(productionRuleCases())(
    "allows %s through normalized request inputs",
    (_caseName, rule) => {
      expect(
        evaluateConfiguredTokenPolicy(
          {
            subjectToken: subjectTokenForRule(rule),
            tokenRequest: tokenRequestForRule(rule),
          },
          productionTokenPolicyRules,
        ),
      ).toEqual({
        decision: "allow",
        matchedRule: rule,
      });
    },
  );

  it.each(productionRuleCases())(
    "denies %s when the repository claim changes",
    (_caseName, rule) => {
      expectProductionRuleDenied(rule, {
        subjectToken: subjectTokenForRule(rule, {
          repository: `${claimStringFromCondition(rule.when, "repository")}-unconfigured`,
        }),
      });
    },
  );

  it.each(productionRuleCases())(
    "denies %s when the workflow ref claim changes",
    (_caseName, rule) => {
      expectProductionRuleDenied(rule, {
        subjectToken: subjectTokenForRule(rule, {
          workflowRef: `${claimStringFromCondition(rule.when, "workflow_ref")}-unconfigured`,
        }),
      });
    },
  );

  it.each(productionRuleCases())("denies %s when the subject claim changes", (_caseName, rule) => {
    const subjectToken = subjectTokenForRule(rule);

    expectProductionRuleDenied(rule, {
      subjectToken: {
        ...subjectToken,
        claims: {
          ...subjectToken.claims,
          sub: "repo:unconfigured/repository:ref:refs/heads/main",
        },
      },
    });
  });

  it.each(productionRuleCases())("denies %s when the resource changes", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      tokenRequest: {
        ...tokenRequestForRule(rule),
        resource: unconfiguredResourceForRule(rule),
      },
    });
  });

  it.each(productionRuleCases())("denies %s when the permissions change", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      tokenRequest: {
        ...tokenRequestForRule(rule),
        permissions: {
          metadata: "read",
        },
      },
    });
  });
});

function expectProductionRuleDenied(
  rule: TokenPolicyRule,
  overrides: {
    subjectToken?: ReturnType<typeof subjectTokenForRule>;
    tokenRequest?: InstallationAccessTokenRequest;
  },
): void {
  expect(
    evaluateConfiguredTokenPolicy(
      {
        subjectToken: overrides.subjectToken ?? subjectTokenForRule(rule),
        tokenRequest: overrides.tokenRequest ?? tokenRequestForRule(rule),
      },
      productionTokenPolicyRules,
    ),
  ).toMatchObject({ decision: "deny" });
}

function tokenRequestForRule(rule: TokenPolicyRule): InstallationAccessTokenRequest {
  return {
    permissions: rule.issue.githubInstallationToken.permissions,
    resource: new URL(rule.issue.githubInstallationToken.resource),
    scope: Object.entries(rule.issue.githubInstallationToken.permissions)
      .map(([permission, level]) => `${permission}:${level}`)
      .sort()
      .join(" "),
  };
}

function productionRuleCases(): ReadonlyArray<readonly [string, TokenPolicyRule]> {
  return productionTokenPolicyRules.map((rule) => [rule.id, rule] as const);
}

function unconfiguredResourceForRule(rule: TokenPolicyRule): URL {
  const configuredResources = new Set(
    productionTokenPolicyRules.map(
      (policyRule) => policyRule.issue.githubInstallationToken.resource,
    ),
  );
  const resource = new URL(rule.issue.githubInstallationToken.resource);
  const pathParts = resource.pathname.split("/");
  const repository = pathParts[3];

  if (repository === undefined) {
    throw new Error("production token policy rule resource must name a repository");
  }

  do {
    pathParts[3] = `${pathParts[3] ?? repository}-unconfigured`;
    resource.pathname = pathParts.join("/");
  } while (configuredResources.has(resource.href));

  return resource;
}

function claimStringFromCondition(condition: string, claim: string): string {
  const match = new RegExp(`claims\\["${claim}"\\] == "([^"]+)"`, "u").exec(condition);

  if (match?.[1] === undefined) {
    throw new Error(`production token policy rule must name ${claim}`);
  }

  return match[1];
}
