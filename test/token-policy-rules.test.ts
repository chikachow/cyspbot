import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  type InstallationAccessTokenRequest,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import { tokenPolicyRules as productionTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy-rules";
import {
  mustNormalizeTokenRequest,
  principalForRule,
  tokenRequestForRule,
} from "./support/token-policy-fixtures.ts";

describe("Production Token Policy rules", () => {
  it("contains checked-in rules", () => {
    expect(productionTokenPolicyRules.length).toBeGreaterThan(0);
  });

  it.each(["schedule", "workflow_dispatch"])(
    "allows this repository's pnpm-up %s workflow through default token request inputs",
    (eventName) => {
      const rule = requiredProductionRule({
        principalRepository: "chikachow/cyspbot",
        principalWorkflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
        resource: "https://api.github.com/repos/chikachow/cyspbot",
      });
      const productionPrincipal = principalForRule(rule, eventName);
      const tokenRequest = mustNormalizeTokenRequest(productionPrincipal, {
        resource: null,
        scope: null,
      });

      expect(tokenRequest).toEqual({
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        resource: new URL("https://api.github.com/repos/chikachow/cyspbot"),
        scope: "contents:write pull_requests:write",
      });
      expect(
        evaluateConfiguredTokenPolicy(
          {
            principal: productionPrincipal,
            tokenRequest,
          },
          productionTokenPolicyRules,
        ),
      ).toEqual({
        decision: "allow",
        matchedRule: rule,
      });
    },
  );

  it("allows cyspbot-deploy's update workflow through contents and pull-requests write scope", () => {
    const rule = requiredProductionRule({
      principalRepository: "chikachow/cyspbot-deploy",
      principalWorkflowRef:
        "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
      resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    });
    const productionPrincipal = principalForRule(rule, "workflow_dispatch");
    const tokenRequest = mustNormalizeTokenRequest(productionPrincipal, {
      resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
      scope: "contents:write pull_requests:write",
    });

    expect(tokenRequest).toEqual({
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
      resource: new URL("https://api.github.com/repos/chikachow/cyspbot-deploy"),
      scope: "contents:write pull_requests:write",
    });
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal: productionPrincipal,
          tokenRequest,
        },
        productionTokenPolicyRules,
      ),
    ).toEqual({
      decision: "allow",
      matchedRule: rule,
    });
  });

  it.each(["workflow_run", "workflow_dispatch"])(
    "allows this repository's deploy update workflow on %s through actions-write scope",
    (eventName) => {
      const rule = requiredProductionRule({
        principalRepository: "chikachow/cyspbot",
        principalWorkflowRef:
          "chikachow/cyspbot/.github/workflows/run-cyspbot-deploy-update.yml@refs/heads/main",
        resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
      });
      const productionPrincipal = principalForRule(rule, eventName);
      const tokenRequest = mustNormalizeTokenRequest(productionPrincipal, {
        resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
        scope: "actions:write",
      });

      expect(tokenRequest).toEqual({
        permissions: {
          actions: "write",
        },
        resource: new URL("https://api.github.com/repos/chikachow/cyspbot-deploy"),
        scope: "actions:write",
      });
      expect(
        evaluateConfiguredTokenPolicy(
          {
            principal: productionPrincipal,
            tokenRequest,
          },
          productionTokenPolicyRules,
        ),
      ).toEqual({
        decision: "allow",
        matchedRule: rule,
      });
    },
  );

  it.each(productionRuleEventCases())(
    "allows %s through normalized scope and resource inputs",
    (_caseName, rule, eventName) => {
      const productionPrincipal = principalForRule(rule, eventName);
      const tokenRequest = tokenRequestForRule(rule);

      expect(
        evaluateConfiguredTokenPolicy(
          {
            principal: productionPrincipal,
            tokenRequest,
          },
          productionTokenPolicyRules,
        ),
      ).toEqual({
        decision: "allow",
        matchedRule: rule,
      });
    },
  );

  it.each(productionRuleCases())("denies %s when the repository changes", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      principal: {
        ...principalForRule(rule),
        repository: `${rule.principalRepository}-unconfigured`,
      },
    });
  });

  it.each(productionRuleCases())("denies %s when the event changes", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      principal: principalForRule(rule, unconfiguredEventName(rule)),
    });
  });

  it.each(productionRuleCases())("denies %s when the ref changes", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      principal: principalForRule(rule, undefined, `${rule.principalRef}-unconfigured`),
    });
  });

  it.each(productionRuleCases())("denies %s when the workflow ref changes", (_caseName, rule) => {
    expectProductionRuleDenied(rule, {
      principal: {
        ...principalForRule(rule),
        workflowRef: `${rule.principalWorkflowRef}-unconfigured`,
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
    principal?: ReturnType<typeof principalForRule>;
    tokenRequest?: InstallationAccessTokenRequest;
  },
): void {
  expect(
    evaluateConfiguredTokenPolicy(
      {
        principal: overrides.principal ?? principalForRule(rule),
        tokenRequest: overrides.tokenRequest ?? tokenRequestForRule(rule),
      },
      productionTokenPolicyRules,
    ),
  ).toMatchObject({ decision: "deny" });
}

function requiredProductionRule(criteria: {
  principalRepository: string;
  principalWorkflowRef: string;
  resource: string;
}): TokenPolicyRule {
  const rule = productionTokenPolicyRules.find(
    (productionRule) =>
      productionRule.principalRepository === criteria.principalRepository &&
      productionRule.principalWorkflowRef === criteria.principalWorkflowRef &&
      productionRule.resource === criteria.resource,
  );

  if (rule === undefined) {
    throw new Error("production token policy rule not found");
  }

  return rule;
}

function productionRuleCases(): ReadonlyArray<readonly [string, TokenPolicyRule]> {
  return productionTokenPolicyRules.map((rule) => [productionRuleCaseName(rule), rule] as const);
}

function productionRuleEventCases(): ReadonlyArray<readonly [string, TokenPolicyRule, string]> {
  return productionTokenPolicyRules.flatMap((rule) =>
    rule.principalEventNames.map(
      (eventName) => [`${productionRuleCaseName(rule)} ${eventName}`, rule, eventName] as const,
    ),
  );
}

function productionRuleCaseName(rule: TokenPolicyRule): string {
  return `${rule.principalRepository} ${rule.principalWorkflowRef} ${rule.resource}`;
}

function unconfiguredEventName(rule: TokenPolicyRule): string {
  let eventName = "fixture-unconfigured-event";

  while (rule.principalEventNames.includes(eventName)) {
    eventName = `${eventName}-next`;
  }

  return eventName;
}

function unconfiguredResourceForRule(rule: TokenPolicyRule): URL {
  const configuredResources = new Set(
    productionTokenPolicyRules.map((policyRule) => policyRule.resource),
  );
  const resource = new URL(rule.resource);
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
