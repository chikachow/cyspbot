import { describe, expect, it } from "vitest";

import { githubActionsOidcProviderRegistration } from "@cyspbot/oidc-provider-github-actions";
import {
  installationAccessTokenPermissionsEqual,
} from "@cyspbot/token-exchange/installation-access-token-request";
import {
  evaluateConfiguredTokenPolicy,
  type TokenPolicyDecision,
} from "@cyspbot/token-exchange/policy/token-policy";
import { tokenPolicyRules as celTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy-rules";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepository,
  oidcSubjectTokenConstraint,
  tokenIssuancePolicyPermits,
} from "@cyspbot/token-exchange/policy/token-issuance-policy";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import {
  allNonEmptyGitHubInstallationPermissionMaps,
  configuredPermissionsCover,
  configuredRequest,
  configuredSubjectToken,
  configuredTokenIssuancePolicyScenarios,
  type ConfiguredTokenIssuancePolicyScenario,
} from "./support/configured-token-issuance-policy.ts";

const booleanTokenIssuancePolicy = compileTokenIssuancePolicy(
  configuredTokenIssuancePolicyScenarios.map(booleanPermitStatement),
);

const individualBooleanPolicies = configuredTokenIssuancePolicyScenarios.map((scenario) =>
  compileTokenIssuancePolicy([
    {
      ...booleanPermitStatement(scenario),
      permissions: { actions: "write", contents: "write", pull_requests: "write" },
    },
  ]),
);

describe("CEL-to-Boolean configured policy differential", () => {
  it("classifies all 234 permission-request results as equivalent or ordered coverage", () => {
    const classifications = { equivalent: 0, orderedCoverage: 0 };

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      const subjectToken = configuredSubjectToken(scenario);

      for (const permissions of allNonEmptyGitHubInstallationPermissionMaps) {
        const request = configuredRequest(scenario, permissions);
        const celPermits = celDecision(subjectToken, request);
        const booleanPermits = tokenIssuancePolicyPermits(
          booleanTokenIssuancePolicy,
          subjectToken,
          request,
        );
        const context = `${scenario.name}: ${JSON.stringify(permissions)}`;

        if (celPermits === booleanPermits) {
          expect(booleanPermits, context).toBe(
            installationAccessTokenPermissionsEqual(permissions, scenario.permissions),
          );
          classifications.equivalent += 1;
          continue;
        }

        expect(celPermits, context).toBe(false);
        expect(booleanPermits, context).toBe(true);
        expect(configuredPermissionsCover(scenario.permissions, permissions), context).toBe(true);
        classifications.orderedCoverage += 1;
      }
    }

    expect(classifications.equivalent + classifications.orderedCoverage).toBe(9 * 26);
    expect(classifications.orderedCoverage).toBeGreaterThan(0);
  });

  it("has no differences for issuer, selected-Claim, Claim-type, or Resource mutations", () => {
    const nonMatchingClaimValues: readonly unknown[] = ["unconfigured", null, false, 123, [], {}];
    let comparisons = 0;

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      for (const claimName of [
        "repository",
        "event_name",
        "ref_type",
        "ref",
        "workflow_ref",
      ] as const) {
        for (const claimValue of nonMatchingClaimValues) {
          expectEquivalentDenial(
            scenario,
            configuredSubjectToken(scenario, { [claimName]: claimValue }),
            `${claimName}=${JSON.stringify(claimValue)}`,
          );
          comparisons += 1;
        }

        expectEquivalentDenial(
          scenario,
          withoutClaim(configuredSubjectToken(scenario), claimName),
          `missing ${claimName}`,
        );
        comparisons += 1;
      }

      for (const [resourceOwner, resourceRepository, mutationName] of [
        [`${scenario.resourceOwner}-other`, scenario.resourceRepository, "resource owner"],
        [scenario.resourceOwner, `${scenario.resourceRepository}-other`, "resource repository"],
      ] as const) {
        const subjectToken = configuredSubjectToken(scenario);
        const request = configuredRequest(
          scenario,
          scenario.permissions,
          resourceOwner,
          resourceRepository,
        );

        expect(celDecision(subjectToken, request), `${scenario.name}: CEL ${mutationName}`).toBe(
          false,
        );
        expect(
          tokenIssuancePolicyPermits(booleanTokenIssuancePolicy, subjectToken, request),
          `${scenario.name}: Boolean ${mutationName}`,
        ).toBe(false);
        comparisons += 1;
      }

      expectEquivalentDenial(
        scenario,
        configuredSubjectToken(scenario, {}, { issuer: "https://unconfigured-issuer.example" }),
        "issuer",
      );
      comparisons += 1;
    }

    expect(comparisons).toBe(9 * (5 * 7 + 2 + 1));
  });

  it("classifies only customized, missing, and malformed sub as intentionally changed", () => {
    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      const subjectTokens = [
        ["legacy", configuredSubjectToken(scenario), true],
        [
          "immutable",
          configuredSubjectToken(scenario, {
            sub: `repo:${scenario.repository.replace("/", "@555555/")}@123456789:ref:${scenario.ref}`,
          }),
          true,
        ],
        ["customized", configuredSubjectToken(scenario, { sub: `custom:${scenario.name}` }), false],
        ["missing", withoutClaim(configuredSubjectToken(scenario), "sub"), false],
        ["malformed", configuredSubjectToken(scenario, { sub: 123 }), false],
      ] as const;

      for (const [subForm, subjectToken, celExpected] of subjectTokens) {
        const request = configuredRequest(scenario, scenario.permissions);

        expect(celDecision(subjectToken, request), `${scenario.name}: CEL ${subForm}`).toBe(
          celExpected,
        );
        expect(
          tokenIssuancePolicyPermits(booleanTokenIssuancePolicy, subjectToken, request),
          `${scenario.name}: Boolean ${subForm}`,
        ).toBe(true);
      }
    }
  });

  it("has exactly one constraint-applicable configured statement for every accepted event", () => {
    let comparisons = 0;

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      for (const eventName of scenario.events) {
        const subjectToken = configuredSubjectToken(scenario, { event_name: eventName });
        const request = configuredRequest(scenario, scenario.permissions);
        const applicableStatements = individualBooleanPolicies.filter((policy) =>
          tokenIssuancePolicyPermits(policy, subjectToken, request),
        );

        expect(applicableStatements, `${scenario.name}: ${eventName}`).toHaveLength(1);
        expect(celDecision(subjectToken, request), `${scenario.name}: CEL ${eventName}`).toBe(true);
        comparisons += 1;
      }
    }

    expect(comparisons).toBe(17);
  });
});

function booleanPermitStatement(scenario: ConfiguredTokenIssuancePolicyScenario) {
  return {
    permissions: scenario.permissions,
    resource: githubRepository(scenario.resourceOwner, scenario.resourceRepository),
    subjectToken: oidcSubjectTokenConstraint(
      githubActionsOidcProviderRegistration.issuer,
      claimEquals("repository", scenario.repository),
      claimOneOf("event_name", scenario.events),
      claimEquals("ref_type", "branch"),
      claimEquals("ref", scenario.ref),
      claimEquals("workflow_ref", scenario.workflowRef),
    ),
  };
}

function celDecision(
  subjectToken: VerifiedSubjectToken,
  request: ReturnType<typeof configuredRequest>,
): boolean {
  return decisionPermits(
    evaluateConfiguredTokenPolicy(
      { tokenRequest: request, verifiedSubjectToken: subjectToken },
      celTokenPolicyRules,
    ),
  );
}

function decisionPermits(decision: TokenPolicyDecision): boolean {
  return decision.decision === "allow";
}

function expectEquivalentDenial(
  scenario: ConfiguredTokenIssuancePolicyScenario,
  subjectToken: VerifiedSubjectToken,
  mutationName: string,
): void {
  const request = configuredRequest(scenario, scenario.permissions);

  expect(celDecision(subjectToken, request), `${scenario.name}: CEL ${mutationName}`).toBe(false);
  expect(
    tokenIssuancePolicyPermits(booleanTokenIssuancePolicy, subjectToken, request),
    `${scenario.name}: Boolean ${mutationName}`,
  ).toBe(false);
}

function withoutClaim<SubjectToken extends VerifiedSubjectToken>(
  subjectToken: SubjectToken,
  claimName: string,
): SubjectToken {
  const claims = { ...subjectToken.claims };
  delete claims[claimName];

  return { ...subjectToken, claims: Object.freeze(claims) };
}
