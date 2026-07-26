import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  validateTokenPolicyRules,
  type TokenPolicyRule,
  type TokenPolicyRuleDefinition,
} from "@cyspbot/token-exchange/policy/token-policy";
import { parseOidcIssuerIdentifier } from "@cyspbot/oidc/provider-registration";
import { normalizeInstallationAccessTokenRequest } from "@cyspbot/token-exchange/installation-access-token-request";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import { githubActionsInstallationAccessTokenRule } from "../workers/cyspbot-token-exchange/src/policy/github-actions-token-policy-rule.ts";
import {
  crossOwnerActionsTokenRequest,
  fixtureRef,
  fixtureSourceRepository,
  fixtureSourceResource,
  fixtureTargetResource,
  mustParseRepositoryResource,
  sameRepositoryTokenRequest,
  verifiedSubjectToken,
} from "./support/token-policy-fixtures.ts";
import { createVerifiedSubjectToken } from "./support/oidc.ts";
import { testTokenPolicyRules } from "./support/token-policy.ts";

const fixtureOtherIssuer = mustParseTestIssuer("https://issuer.example");

describe("Token Policy matching", () => {
  it("allows an exact same-repository PR-authoring request", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("allows an exact cross-owner actions request", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: crossOwnerActionsTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it.each([
    ["condition", { repository: "fixture-owner/fixture-other-source" }],
    ["condition", { event_name: "push" }],
    ["condition", { ref_type: "tag" }],
    [
      "condition",
      {
        workflow_ref:
          "fixture-owner/fixture-source-repository/.github/workflows/unconfigured.yml@refs/heads/fixture-base-branch",
      },
    ],
  ])("denies when a claim does not satisfy the CEL %s", (reason, claimsPatch) => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims: {
              ...verifiedSubjectToken.claims,
              ...claimsPatch,
            },
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: [reason],
    });
  });

  it("treats missing CEL claims as non-matching conditions", () => {
    const { repository: _repository, ...claims } = verifiedSubjectToken.claims;

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims,
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("treats CEL type mismatches as non-matching conditions", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims: {
              ...verifiedSubjectToken.claims,
              repository: [fixtureSourceRepository],
            },
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("denies unconfigured resources before evaluating conditions", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: {
            ...crossOwnerActionsTokenRequest(),
            resource: mustParseRepositoryResource(
              "https://api.github.com/repos/fixture-target-owner/fixture-unconfigured-target",
            ),
          },
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["resource"],
    });
  });

  it("denies unconfigured permissions for a configured resource", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: {
            ...sameRepositoryTokenRequest(),
            permissions: {
              actions: "write",
            },
          },
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["permissions"],
    });
  });

  it("allows a policy rule with any issuer-specific claim named by CEL", () => {
    const otherSubjectToken = createVerifiedSubjectToken(
      {
        email: "fixture-service-account@fixture-project.iam.gserviceaccount.com",
        email_verified: true,
        sub: "107517467455664443765",
      },
      { issuer: fixtureOtherIssuer },
    );
    const otherIssuerRule: TokenPolicyRule = {
      effect: "allow",
      id: "test-other-issuer",
      issue: {
        githubInstallationAccessToken: {
          permissions: {
            contents: "write",
          },
          resource: fixtureTargetResource,
        },
      },
      subject: {
        issuer: fixtureOtherIssuer,
      },
      when:
        `claims["sub"] == "107517467455664443765" && ` +
        `claims["email_verified"] == true && ` +
        `claims["email"] == "fixture-service-account@fixture-project.iam.gserviceaccount.com"`,
    };
    const tokenRequest = normalizeInstallationAccessTokenRequest({
      resource: fixtureTargetResource,
      scope: "contents:write",
    });

    expect(tokenRequest).toMatchObject({ ok: true });
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: otherSubjectToken,
          tokenRequest: tokenRequest.ok ? tokenRequest.tokenRequest : sameRepositoryTokenRequest(),
        },
        validateTokenPolicyRules([otherIssuerRule]),
      ),
    ).toEqual({
      decision: "allow",
      matchedRule: otherIssuerRule,
    });
  });

  it.each([
    ["boolean claim", 'claims["tenant_enabled"] == true', { tenant_enabled: true }],
    ["numeric claim", 'claims["run_attempt"] == 2', { run_attempt: 2 }],
    ["list claim", '"deployers" in claims["groups"]', { groups: ["developers", "deployers"] }],
    [
      "list claim comprehension",
      'claims["groups"].exists(group, group == "deployers")',
      { groups: ["developers", "deployers"] },
    ],
    [
      "nested map claim",
      'claims["metadata"]["environment"] == "production"',
      { metadata: { environment: "production" } },
    ],
  ])("allows typed CEL conditions over a %s", (_name, when, additionalClaims) => {
    const typedSubjectToken: VerifiedSubjectToken = {
      claims: {
        ...verifiedSubjectToken.claims,
        iss: fixtureOtherIssuer,
        ...additionalClaims,
      },
      issuer: fixtureOtherIssuer,
    };
    const rule = tokenPolicyRuleWithCondition(when);
    const tokenRequest = normalizeInstallationAccessTokenRequest({
      resource: fixtureTargetResource,
      scope: "contents:write",
    });

    expect(tokenRequest).toMatchObject({ ok: true });
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: typedSubjectToken,
          tokenRequest: tokenRequest.ok ? tokenRequest.tokenRequest : sameRepositoryTokenRequest(),
        },
        validateTokenPolicyRules([rule]),
      ),
    ).toEqual({
      decision: "allow",
      matchedRule: rule,
    });
  });

  it.each([
    ["missing value", {}],
    ["incorrectly typed value", { tenant_enabled: "true" }],
  ])("fails closed when a typed CEL condition receives a %s", (_name, claimsPatch) => {
    const rule = tokenPolicyRuleWithCondition('claims["tenant_enabled"] == true');

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims: {
              ...verifiedSubjectToken.claims,
              ...claimsPatch,
            },
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: mustParseRepositoryResource(fixtureTargetResource),
            scope: "contents:write",
          },
        },
        validateTokenPolicyRules([rule]),
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("fails closed when CEL evaluation throws", () => {
    const claims = { ...verifiedSubjectToken.claims };

    Object.defineProperty(claims, "unreadable", {
      enumerable: true,
      get: () => {
        throw new Error("unreadable claim");
      },
    });

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims,
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: mustParseRepositoryResource(fixtureTargetResource),
            scope: "contents:write",
          },
        },
        validateTokenPolicyRules([tokenPolicyRuleWithCondition('claims["unreadable"] == true')]),
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("does not expose token request fields to CEL conditions", () => {
    const rule = tokenPolicyRuleWithCondition('request["resource"] == "configured"');

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: mustParseRepositoryResource(fixtureTargetResource),
            scope: "contents:write",
          },
        },
        validateTokenPolicyRules([rule]),
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });
});

describe("Token Policy rule validation", () => {
  it.each([
    ["empty id", (rule: TokenPolicyRuleDefinition) => ({ ...rule, id: "" }), "id"],
    [
      "empty issuer",
      (rule: TokenPolicyRuleDefinition) => ({ ...rule, subject: { issuer: "" } }),
      "OIDC Issuer Identifier",
    ],
    [
      "unsupported effect",
      (rule: TokenPolicyRuleDefinition) => ({
        ...rule,
        effect: "deny" as TokenPolicyRuleDefinition["effect"],
      }),
      "effect",
    ],
    [
      "empty resource",
      (rule: TokenPolicyRuleDefinition) => ({
        ...rule,
        issue: {
          githubInstallationAccessToken: {
            ...rule.issue.githubInstallationAccessToken,
            resource: "",
          },
        },
      }),
      "resource",
    ],
    [
      "empty permissions",
      (rule: TokenPolicyRuleDefinition) => ({
        ...rule,
        issue: {
          githubInstallationAccessToken: {
            ...rule.issue.githubInstallationAccessToken,
            permissions: {},
          },
        },
      }),
      "permissions",
    ],
    [
      "unsupported permission",
      (rule: TokenPolicyRuleDefinition) => ({
        ...rule,
        issue: {
          githubInstallationAccessToken: {
            ...rule.issue.githubInstallationAccessToken,
            permissions: { administration: "write" },
          },
        },
      }),
      "permissions",
    ],
    ["empty condition", (rule: TokenPolicyRuleDefinition) => ({ ...rule, when: "" }), "condition"],
  ])("rejects a policy rule with %s", (_name, mutateRule, errorKind) => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() => validateTokenPolicyRules([mutateRule(rule)])).toThrow(
      `invalid token policy rule ${errorKind}`,
    );
  });

  it("accepts a long valid CEL condition", () => {
    const rule = {
      ...(testTokenPolicyRules[0] as TokenPolicyRule),
      when: `claims["sub"] == ${JSON.stringify("x".repeat(10_000))}`,
    };

    expect(validateTokenPolicyRules([rule])).toEqual([rule]);
  });

  it.each([
    "issuer.example",
    "http://issuer.example",
    "https://issuer.example?query",
    "https://issuer.example#fragment",
  ])("rejects an invalid policy OIDC Issuer Identifier: %s", (issuer) => {
    const definition: TokenPolicyRuleDefinition = {
      ...(testTokenPolicyRules[0] as TokenPolicyRule),
      id: "invalid-issuer",
      subject: { issuer },
    };

    expect(() => validateTokenPolicyRules([definition])).toThrow(
      "invalid token policy rule OIDC Issuer Identifier",
    );
  });

  it("returns new deeply frozen rules with exact branded Issuer Identifiers", () => {
    const definition: TokenPolicyRuleDefinition = {
      ...(testTokenPolicyRules[0] as TokenPolicyRule),
      id: "frozen-rule",
    };
    const definitions = [definition];
    const policy = validateTokenPolicyRules(definitions);
    const rule = policy[0];

    expect(policy).not.toBe(definitions);
    expect(rule).not.toBe(definition);
    expect(rule?.subject.issuer).toBe(definition.subject.issuer);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule?.subject)).toBe(true);
    expect(Object.isFrozen(rule?.issue.githubInstallationAccessToken)).toBe(true);
    expect(Object.isFrozen(rule?.issue.githubInstallationAccessToken.permissions)).toBe(true);
  });

  it.each(["owner", "/repository", "owner/", "owner/repository/extra"])(
    "rejects invalid GitHub Actions policy repository %s",
    (repository) => {
      expect(() =>
        githubActionsInstallationAccessTokenRule({
          eventNames: ["workflow_dispatch"],
          id: "invalid-repository",
          permissions: { contents: "write" },
          ref: fixtureRef,
          repository,
          resource: fixtureSourceResource,
          workflowRef:
            "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
        }),
      ).toThrow("GitHub Actions policy repository must be owner/repository");
    },
  );

  it.each([
    ["events", { eventNames: [] }],
    ["ref", { ref: "" }],
    ["workflow ref", { workflowRef: "" }],
  ])("rejects a GitHub Actions policy rule without %s", (_name, optionsPatch) => {
    expect(() =>
      githubActionsInstallationAccessTokenRule({
        eventNames: ["workflow_dispatch"],
        id: "missing-required-input",
        permissions: { contents: "write" },
        ref: fixtureRef,
        repository: fixtureSourceRepository,
        resource: fixtureSourceResource,
        workflowRef:
          "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
        ...optionsPatch,
      }),
    ).toThrow("GitHub Actions policy rule requires events, ref, and workflow ref");
  });

  it("rejects duplicate rule IDs", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        rule,
        {
          ...rule,
        },
      ]),
    ).toThrow("duplicate token policy rule id");
  });

  it("rejects duplicate effective grants regardless of permission order", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        rule,
        {
          ...rule,
          id: `${rule.id}-copy`,
          issue: {
            githubInstallationAccessToken: {
              ...rule.issue.githubInstallationAccessToken,
              permissions: {
                pull_requests: "write",
                contents: "write",
              },
            },
          },
        },
      ]),
    ).toThrow("duplicate token policy rule");
  });

  it("rejects malformed CEL conditions", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          id: "malformed-cel",
          when: "claims[",
        },
      ]),
    ).toThrow("invalid token policy rule condition");
  });

  it("validates non-boolean CEL structurally and denies it at runtime", () => {
    const rule = {
      ...githubActionsInstallationAccessTokenRule({
        eventNames: ["workflow_dispatch"],
        id: "non-boolean-cel",
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        ref: fixtureRef,
        repository: fixtureSourceRepository,
        resource: fixtureSourceResource,
        workflowRef:
          "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
      }),
      when: "1",
    };

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: sameRepositoryTokenRequest(),
        },
        validateTokenPolicyRules([rule]),
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("validates unknown CEL identifiers structurally and denies them at runtime", () => {
    const rule = {
      ...githubActionsInstallationAccessTokenRule({
        eventNames: ["workflow_dispatch"],
        id: "unknown-cel-identifier",
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        ref: fixtureRef,
        repository: fixtureSourceRepository,
        resource: fixtureSourceResource,
        workflowRef:
          "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
      }),
      when: "typo == true",
    };

    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken,
          tokenRequest: sameRepositoryTokenRequest(),
        },
        validateTokenPolicyRules([rule]),
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("denies when the verified subject-token issuer does not match the rule", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["subject_issuer"],
    });
  });
});

function tokenPolicyRuleWithCondition(when: string): TokenPolicyRuleDefinition {
  return {
    effect: "allow",
    id: "test-typed-cel-condition",
    issue: {
      githubInstallationAccessToken: {
        permissions: {
          contents: "write",
        },
        resource: fixtureTargetResource,
      },
    },
    subject: {
      issuer: fixtureOtherIssuer,
    },
    when,
  };
}

function mustParseTestIssuer(value: string) {
  const issuer = parseOidcIssuerIdentifier(value);

  if (issuer === null) {
    throw new TypeError("test fixture issuer must be a valid OIDC Issuer Identifier");
  }

  return issuer;
}
