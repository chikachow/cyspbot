import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  normalizeInstallationAccessTokenRequest,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import { githubActionsInstallationTokenRule } from "../workers/cyspbot-token-exchange/src/policy/github-actions-token-policy-rule.ts";
import {
  crossOwnerActionsTokenRequest,
  fixtureRef,
  fixtureSourceRepository,
  fixtureSourceResource,
  fixtureTargetResource,
  sameRepositoryTokenRequest,
  subjectToken,
} from "./support/token-policy-fixtures.ts";
import { createVerifiedSubjectToken } from "./support/oidc.ts";
import { testTokenPolicyRules } from "./support/token-policy.ts";

const fixtureOtherIssuer = "https://issuer.example";

describe("Token Policy matching", () => {
  it("allows an exact same-repository PR-authoring request", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken,
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
          subjectToken,
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
          subjectToken: {
            ...subjectToken,
            claims: {
              ...subjectToken.claims,
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
    const { repository: _repository, ...claims } = subjectToken.claims;

    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken: {
            ...subjectToken,
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
          subjectToken: {
            ...subjectToken,
            claims: {
              ...subjectToken.claims,
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
          subjectToken,
          tokenRequest: {
            ...crossOwnerActionsTokenRequest(),
            resource: new URL(
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
          subjectToken,
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
      { issuer: fixtureOtherIssuer, resolvedKeyId: "fixture-other-key" },
    );
    const otherIssuerRule: TokenPolicyRule = {
      effect: "allow",
      id: "test-other-issuer",
      issue: {
        githubInstallationToken: {
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
    const tokenRequest = normalizeInstallationAccessTokenRequest(otherSubjectToken, {
      resource: fixtureTargetResource,
      scope: "contents:write",
    });

    expect(tokenRequest).toMatchObject({ ok: true });
    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken: otherSubjectToken,
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
    [
      "subject binding",
      `subject["issuer"] == "${fixtureOtherIssuer}" && subject["subjectTokenType"] == "id_token"`,
      {},
    ],
    [
      "request binding",
      `request["resource"] == "${fixtureTargetResource}" && ` +
        'request["scope"] == "contents:write" && ' +
        'request["permissions"]["contents"] == "write"',
      {},
    ],
  ])("allows typed CEL conditions over a %s", (_name, when, additionalClaims) => {
    const typedSubjectToken: VerifiedSubjectToken = {
      claims: {
        ...subjectToken.claims,
        iss: fixtureOtherIssuer,
        ...additionalClaims,
      },
      issuer: fixtureOtherIssuer,
      resolvedKeyId: "fixture-other-key",
      subjectTokenType: "id_token",
    };
    const rule = tokenPolicyRuleWithCondition(when);
    const tokenRequest = normalizeInstallationAccessTokenRequest(typedSubjectToken, {
      resource: fixtureTargetResource,
      scope: "contents:write",
    });

    expect(tokenRequest).toMatchObject({ ok: true });
    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken: typedSubjectToken,
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
          subjectToken: {
            ...subjectToken,
            claims: {
              ...subjectToken.claims,
              ...claimsPatch,
            },
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: new URL(fixtureTargetResource),
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

  it("fails closed when an unvalidated CEL condition cannot be compiled", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken: {
            ...subjectToken,
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: new URL(fixtureTargetResource),
            scope: "contents:write",
          },
        },
        [tokenPolicyRuleWithCondition("claims[")],
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("fails closed when CEL evaluation throws", () => {
    const claims = { ...subjectToken.claims };

    Object.defineProperty(claims, "unreadable", {
      enumerable: true,
      get: () => {
        throw new Error("unreadable claim");
      },
    });

    expect(
      evaluateConfiguredTokenPolicy(
        {
          subjectToken: {
            ...subjectToken,
            claims,
            issuer: fixtureOtherIssuer,
          },
          tokenRequest: {
            permissions: { contents: "write" },
            resource: new URL(fixtureTargetResource),
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
});

describe("InstallationAccessTokenRequest normalization", () => {
  it("derives omitted GitHub Actions resources from the verified repository claim", () => {
    expect(
      normalizeInstallationAccessTokenRequest(subjectToken, {
        resource: null,
        scope: null,
      }),
    ).toEqual({
      ok: true,
      tokenRequest: {
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        resource: new URL(fixtureSourceResource),
        scope: "contents:write pull_requests:write",
      },
    });
  });

  it("requires explicit resource for non-GitHub subject tokens", () => {
    expect(
      normalizeInstallationAccessTokenRequest(
        {
          ...subjectToken,
          issuer: fixtureOtherIssuer,
        },
        {
          resource: null,
          scope: null,
        },
      ),
    ).toEqual({
      error: "invalid_target",
      ok: false,
    });
  });
});

describe("Token Policy rule validation", () => {
  it.each([
    ["empty id", (rule: TokenPolicyRule) => ({ ...rule, id: "" }), "id"],
    ["empty issuer", (rule: TokenPolicyRule) => ({ ...rule, subject: { issuer: "" } }), "id"],
    [
      "unsupported effect",
      (rule: TokenPolicyRule) => ({ ...rule, effect: "deny" as TokenPolicyRule["effect"] }),
      "effect",
    ],
    [
      "empty resource",
      (rule: TokenPolicyRule) => ({
        ...rule,
        issue: {
          githubInstallationToken: {
            ...rule.issue.githubInstallationToken,
            resource: "",
          },
        },
      }),
      "resource",
    ],
    [
      "empty permissions",
      (rule: TokenPolicyRule) => ({
        ...rule,
        issue: {
          githubInstallationToken: {
            ...rule.issue.githubInstallationToken,
            permissions: {},
          },
        },
      }),
      "permissions",
    ],
    [
      "unsupported permission",
      (rule: TokenPolicyRule) => ({
        ...rule,
        issue: {
          githubInstallationToken: {
            ...rule.issue.githubInstallationToken,
            permissions: { administration: "write" },
          },
        },
      }),
      "permissions",
    ],
    ["empty condition", (rule: TokenPolicyRule) => ({ ...rule, when: "" }), "condition"],
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

  it.each(["owner", "/repository", "owner/", "owner/repository/extra"])(
    "rejects invalid GitHub Actions policy repository %s",
    (repository) => {
      expect(() =>
        githubActionsInstallationTokenRule({
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
      githubActionsInstallationTokenRule({
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

  it("rejects duplicate effective grants", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        rule,
        {
          ...rule,
          id: `${rule.id}-copy`,
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
      ...githubActionsInstallationTokenRule({
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
          subjectToken,
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
      ...githubActionsInstallationTokenRule({
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
          subjectToken,
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
          subjectToken: {
            ...subjectToken,
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

function tokenPolicyRuleWithCondition(when: string): TokenPolicyRule {
  return {
    effect: "allow",
    id: "test-typed-cel-condition",
    issue: {
      githubInstallationToken: {
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
