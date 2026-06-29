import { describe, expect, it } from "vitest";

import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import {
  evaluateConfiguredTokenPolicy,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import {
  crossOwnerActionsTokenRequest,
  fixtureRef,
  fixtureSourceRepository,
  principal,
  principalWithRef,
  sameRepositoryTokenRequest,
  unconfiguredWorkflowRef,
} from "./support/token-policy-fixtures.ts";
import { testTokenPolicyRules } from "./support/token-policy.ts";

describe("Token Policy matching", () => {
  it("allows an exact same-repository PR-authoring request", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal,
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
          principal,
          tokenRequest: crossOwnerActionsTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("matches parsed subject ref rather than raw subject repository syntax", () => {
    const immutableSubjectPrincipal: GitHubActionsPrincipal = {
      ...principal,
      rawSubject:
        "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      subject: {
        kind: "ref",
        raw: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
        ref: fixtureRef,
        repositorySubject: "fixture-owner@555555/fixture-source-repository@123456789",
      },
    };

    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal: immutableSubjectPrincipal,
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it.each([
    ["repository", { repository: "fixture-owner/fixture-other-source" }],
    ["event", { eventName: "push" }],
    ["ref type", { refType: "tag" }],
    ["workflow ref", { workflowRef: unconfiguredWorkflowRef() }],
  ])("denies when %s does not match a rule", (_caseName, principalPatch) => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal: {
            ...principal,
            ...principalPatch,
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies when the branch ref and parsed subject ref do not match a rule", () => {
    const ref = "refs/heads/fixture-unconfigured-branch";

    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal: principalWithRef(ref),
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies non-ref subject contexts", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal: {
            ...principal,
            rawSubject: `repo:${fixtureSourceRepository}:pull_request`,
            subject: {
              kind: "pull_request",
              raw: `repo:${fixtureSourceRepository}:pull_request`,
              repositorySubject: fixtureSourceRepository,
            },
          },
          tokenRequest: sameRepositoryTokenRequest(),
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies unconfigured resources", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal,
          tokenRequest: {
            ...crossOwnerActionsTokenRequest(),
            resource: new URL(
              "https://api.github.com/repos/fixture-target-owner/fixture-unconfigured-target",
            ),
          },
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies unconfigured GitHub Apps", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal,
          tokenRequest: {
            ...sameRepositoryTokenRequest(),
            githubAppSlug: "fixture-other-app",
          },
        },
        testTokenPolicyRules,
      ),
    ).toEqual({
      decision: "deny",
      reasons: ["github_app"],
    });
  });

  it("denies unconfigured permissions", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal,
          tokenRequest: {
            ...sameRepositoryTokenRequest(),
            permissions: {
              actions: "write",
            },
          },
        },
        testTokenPolicyRules,
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("does not depend on rule order", () => {
    expect(
      evaluateConfiguredTokenPolicy(
        {
          principal,
          tokenRequest: crossOwnerActionsTokenRequest(),
        },
        [...testTokenPolicyRules].reverse(),
      ),
    ).toMatchObject({ decision: "allow" });
  });
});

describe("Token Policy rule validation", () => {
  it("rejects duplicate equivalent rules", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        rule,
        {
          ...rule,
          permissions: {
            pull_requests: "write",
            contents: "write",
          },
          principalEventNames: [...rule.principalEventNames].reverse(),
        },
      ]),
    ).toThrow("duplicate token policy rule");
  });

  it("rejects invalid rule resources", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          resource: "https://github.com/fixture-owner/fixture-source-repository",
        },
      ]),
    ).toThrow("invalid token policy rule resource");
  });

  it("rejects non-canonical rule resources", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          resource: ` ${rule.resource} `,
        },
      ]),
    ).toThrow("invalid token policy rule resource");
  });

  it("rejects rules without events", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          principalEventNames: [],
        },
      ]),
    ).toThrow("invalid token policy rule events");
  });

  it("accepts read permission levels in rules", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          permissions: {
            contents: "read",
            pull_requests: "read",
          },
        },
      ]),
    ).not.toThrow();
  });

  it("rejects permissions that cannot be requested by normalized scope", () => {
    const rule = testTokenPolicyRules[0] as TokenPolicyRule;

    expect(() =>
      validateTokenPolicyRules([
        {
          ...rule,
          permissions: {
            pull_request: "write",
          },
        },
      ]),
    ).toThrow("invalid token policy rule permissions");
  });
});
