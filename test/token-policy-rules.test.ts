import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import type { InstallationAccessTokenRequest } from "@cyspbot/token-exchange/policy/installation-token-request";
import { tokenPolicyRules as productionTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy-rules";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import { subjectToken } from "./support/token-policy-fixtures.ts";

interface ExpectedProductionRule {
  events: readonly string[];
  id: string;
  permissions: Record<string, string>;
  ref: string;
  repository: string;
  resource: string;
  workflowRef: string;
}

const expectedProductionRules: readonly ExpectedProductionRule[] = [
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-cyspbot-pnpm-up",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot",
    resource: "https://api.github.com/repos/chikachow/cyspbot",
    workflowRef: "chikachow/cyspbot/.github/workflows/pnpm-up.yml@refs/heads/main",
  },
  {
    events: ["workflow_run", "workflow_dispatch"],
    id: "github-actions-cyspbot-run-deploy-update",
    permissions: { actions: "write" },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    workflowRef:
      "chikachow/cyspbot/.github/workflows/run-cyspbot-deploy-update.yml@refs/heads/main",
  },
  {
    events: ["workflow_dispatch"],
    id: "github-actions-cyspbot-deploy-update",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot-deploy",
    resource: "https://api.github.com/repos/chikachow/cyspbot-deploy",
    workflowRef: "chikachow/cyspbot-deploy/.github/workflows/update-cyspbot.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-app-token-action-pnpm-up",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "chikachow/cyspbot-app-token-action",
    resource: "https://api.github.com/repos/chikachow/cyspbot-app-token-action",
    workflowRef: "chikachow/cyspbot-app-token-action/.github/workflows/pnpm-up.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-graphql-schema-registry-pnpm-up",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "cysp/graphql-schema-registry",
    resource: "https://api.github.com/repos/cysp/graphql-schema-registry",
    workflowRef: "cysp/graphql-schema-registry/.github/workflows/pnpm-up.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-braze-update-indirect-dependencies",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-braze",
    resource: "https://api.github.com/repos/cysp/terraform-provider-braze",
    workflowRef:
      "cysp/terraform-provider-braze/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-censusworkspace-update-indirect-dependencies",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-censusworkspace",
    resource: "https://api.github.com/repos/cysp/terraform-provider-censusworkspace",
    workflowRef:
      "cysp/terraform-provider-censusworkspace/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-contentful-update-indirect-dependencies",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-contentful",
    resource: "https://api.github.com/repos/cysp/terraform-provider-contentful",
    workflowRef:
      "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  },
  {
    events: ["schedule", "workflow_dispatch"],
    id: "github-actions-terraform-provider-typesense-update-indirect-dependencies",
    permissions: { contents: "write", pull_requests: "write" },
    ref: "refs/heads/main",
    repository: "cysp/terraform-provider-typesense",
    resource: "https://api.github.com/repos/cysp/terraform-provider-typesense",
    workflowRef:
      "cysp/terraform-provider-typesense/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  },
];

describe("Production Token Policy rules", () => {
  it("contains exactly the expected checked-in grants", () => {
    expect(productionTokenPolicyRules.map((rule) => rule.id)).toEqual(
      expectedProductionRules.map((rule) => rule.id),
    );
  });

  it("has valid checked-in rules", () => {
    expect(validateTokenPolicyRules(productionTokenPolicyRules)).toBe(productionTokenPolicyRules);
  });

  it.each(productionRuleEventCases())(
    "allows %s through explicit expected claims and request inputs",
    (_caseName, expected, eventName) => {
      const rule = productionRule(expected);

      expect(
        evaluateConfiguredTokenPolicy(
          {
            subjectToken: subjectTokenForExpectedRule(expected, eventName),
            tokenRequest: tokenRequestForExpectedRule(expected),
          },
          productionTokenPolicyRules,
        ),
      ).toEqual({ decision: "allow", matchedRule: rule });
    },
  );

  it.each(expectedProductionRules)("denies $id when the repository claim changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      subjectToken: subjectTokenForExpectedRule(expected, expected.events[0] ?? "", {
        repository: `${expected.repository}-unconfigured`,
      }),
    });
  });

  it.each(expectedProductionRules)("denies $id when the event changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      subjectToken: subjectTokenForExpectedRule(expected, "fixture-unconfigured-event"),
    });
  });

  it.each(expectedProductionRules)("denies $id when the ref changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      subjectToken: subjectTokenForExpectedRule(expected, expected.events[0] ?? "", {
        ref: `${expected.ref}-unconfigured`,
      }),
    });
  });

  it.each(expectedProductionRules)("denies $id when the workflow ref changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      subjectToken: subjectTokenForExpectedRule(expected, expected.events[0] ?? "", {
        workflow_ref: `${expected.workflowRef}-unconfigured`,
      }),
    });
  });

  it.each(expectedProductionRules)("denies $id when the subject changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      subjectToken: subjectTokenForExpectedRule(expected, expected.events[0] ?? "", {
        sub: "repo:unconfigured/repository:ref:refs/heads/main",
      }),
    });
  });

  it.each(expectedProductionRules)("denies $id when the resource changes", (expected) => {
    expectExpectedRuleDenied(expected, {
      tokenRequest: {
        ...tokenRequestForExpectedRule(expected),
        resource: unconfiguredResource(expected.resource),
      },
    });
  });

  it.each(expectedProductionRules)("denies $id when the permissions change", (expected) => {
    expectExpectedRuleDenied(expected, {
      tokenRequest: {
        ...tokenRequestForExpectedRule(expected),
        permissions: { metadata: "read" },
      },
    });
  });
});

function productionRuleEventCases(): ReadonlyArray<
  readonly [string, ExpectedProductionRule, string]
> {
  return expectedProductionRules.flatMap((expected) =>
    expected.events.map((eventName) => [`${expected.id} ${eventName}`, expected, eventName]),
  );
}

function productionRule(expected: ExpectedProductionRule): TokenPolicyRule {
  const rule = productionTokenPolicyRules.find(({ id }) => id === expected.id);

  if (rule === undefined) {
    throw new Error(`production token policy rule ${expected.id} not found`);
  }

  return rule;
}

function subjectTokenForExpectedRule(
  expected: ExpectedProductionRule,
  eventName: string,
  claims: Record<string, unknown> = {},
): VerifiedSubjectToken {
  const ref = typeof claims["ref"] === "string" ? claims["ref"] : expected.ref;
  const repository =
    typeof claims["repository"] === "string" ? claims["repository"] : expected.repository;

  return {
    ...subjectToken,
    claims: {
      ...subjectToken.claims,
      event_name: eventName,
      ref,
      repository,
      sub: `repo:${repository}:ref:${ref}`,
      workflow_ref: expected.workflowRef,
      ...claims,
    },
  };
}

function tokenRequestForExpectedRule(
  expected: ExpectedProductionRule,
): InstallationAccessTokenRequest {
  return {
    permissions: expected.permissions,
    resource: new URL(expected.resource),
    scope: Object.entries(expected.permissions)
      .map(([permission, level]) => `${permission}:${level}`)
      .sort()
      .join(" "),
  };
}

function expectExpectedRuleDenied(
  expected: ExpectedProductionRule,
  overrides: {
    subjectToken?: VerifiedSubjectToken;
    tokenRequest?: InstallationAccessTokenRequest;
  },
): void {
  expect(
    evaluateConfiguredTokenPolicy(
      {
        subjectToken:
          overrides.subjectToken ?? subjectTokenForExpectedRule(expected, expected.events[0] ?? ""),
        tokenRequest: overrides.tokenRequest ?? tokenRequestForExpectedRule(expected),
      },
      productionTokenPolicyRules,
    ),
  ).toMatchObject({ decision: "deny" });
}

function unconfiguredResource(resource: string): URL {
  const url = new URL(resource);
  const parts = url.pathname.split("/");

  parts[3] = `${parts[3] ?? "repository"}-unconfigured`;
  url.pathname = parts.join("/");

  return url;
}
