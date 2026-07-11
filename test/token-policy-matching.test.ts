import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  normalizeInstallationAccessTokenRequest,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import {
  crossOwnerActionsTokenRequest,
  fixtureRef,
  fixtureSourceRepository,
  fixtureSourceResource,
  fixtureTargetResource,
  sameRepositoryTokenRequest,
  subjectToken,
} from "./support/token-policy-fixtures.ts";
import { githubActionsRule, testTokenPolicyRules } from "./support/token-policy.ts";

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
    const otherSubjectToken: VerifiedSubjectToken = {
      claims: {
        email: "fixture-service-account@fixture-project.iam.gserviceaccount.com",
        email_verified: true,
        sub: "107517467455664443765",
      },
      issuer: fixtureOtherIssuer,
      resolvedKeyId: "fixture-other-key",
      subjectTokenType: "id_token",
    };
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

  it("rejects CEL conditions that do not produce booleans", () => {
    expect(() =>
      validateTokenPolicyRules([
        {
          ...githubActionsRule({
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
        },
      ]),
    ).toThrow("invalid token policy rule condition");
  });

  it("rejects CEL conditions with unknown root identifiers", () => {
    expect(() =>
      validateTokenPolicyRules([
        {
          ...githubActionsRule({
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
        },
      ]),
    ).toThrow("invalid token policy rule condition");
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
