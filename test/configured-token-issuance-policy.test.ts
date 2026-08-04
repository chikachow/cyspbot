import { describe, expect, it } from "vitest";

import { configuredTokenIssuancePolicy } from "@cyspbot/token-exchange/policy/configured-token-issuance-policy";
import { tokenIssuancePolicyPermits } from "@cyspbot/token-exchange/policy/token-issuance-policy";
import {
  allNonEmptyGitHubInstallationPermissionMaps,
  configuredPermissionsCover,
  configuredRequest,
  configuredSubjectToken,
  configuredTokenIssuancePolicyScenarios,
} from "./support/configured-token-issuance-policy.ts";

describe("configured Token Issuance Policy", () => {
  it("permits every configured event with its exact request", () => {
    let scenarios = 0;

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      for (const eventName of scenario.events) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            configuredSubjectToken(scenario, { event_name: eventName }),
            configuredRequest(scenario, scenario.permissions),
          ),
          `${scenario.name}: ${eventName}`,
        ).toBe(true);
        scenarios += 1;
      }
    }

    expect(scenarios).toBe(24);
  });

  it("matches the accepted ordered-coverage matrix for all 338 requests", () => {
    let scenarios = 0;

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      const subjectToken = configuredSubjectToken(scenario);

      for (const permissions of allNonEmptyGitHubInstallationPermissionMaps) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectToken,
            configuredRequest(scenario, permissions),
          ),
          `${scenario.name}: ${JSON.stringify(permissions)}`,
        ).toBe(configuredPermissionsCover(scenario.permissions, permissions));
        scenarios += 1;
      }
    }

    expect(scenarios).toBe(13 * 26);
  });

  it("does not permit issuer, selected-Claim, Claim-type, or Repository Resource mutations", () => {
    let scenarios = 0;
    const nonMatchingClaimValues: readonly unknown[] = ["unconfigured", null, false, 123, [], {}];

    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      for (const claimName of [
        "repository",
        "event_name",
        "ref_type",
        "ref",
        "workflow_ref",
      ] as const) {
        for (const claimValue of nonMatchingClaimValues) {
          expect(
            tokenIssuancePolicyPermits(
              configuredTokenIssuancePolicy,
              configuredSubjectToken(scenario, { [claimName]: claimValue }),
              configuredRequest(scenario, scenario.permissions),
            ),
            `${scenario.name}: ${claimName}=${JSON.stringify(claimValue)}`,
          ).toBe(false);
          scenarios += 1;
        }

        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            withoutClaim(configuredSubjectToken(scenario), claimName),
            configuredRequest(scenario, scenario.permissions),
          ),
          `${scenario.name}: missing ${claimName}`,
        ).toBe(false);
        scenarios += 1;
      }

      for (const [resourceOwner, resourceRepository, mutationName] of [
        [`${scenario.resourceOwner}-other`, scenario.resourceRepository, "resource owner"],
        [scenario.resourceOwner, `${scenario.resourceRepository}-other`, "resource repository"],
      ] as const) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            configuredSubjectToken(scenario),
            configuredRequest(scenario, scenario.permissions, resourceOwner, resourceRepository),
          ),
          `${scenario.name}: ${mutationName}`,
        ).toBe(false);
        scenarios += 1;
      }

      expect(
        tokenIssuancePolicyPermits(
          configuredTokenIssuancePolicy,
          configuredSubjectToken(scenario, {}, { issuer: "https://unconfigured-issuer.example" }),
          configuredRequest(scenario, scenario.permissions),
        ),
        `${scenario.name}: issuer`,
      ).toBe(false);
      scenarios += 1;
    }

    expect(scenarios).toBe(13 * (5 * 7 + 2 + 1));
  });

  it("permits every legacy, immutable, customized, missing, and malformed sub form", () => {
    for (const scenario of configuredTokenIssuancePolicyScenarios) {
      const subjectTokens = [
        ["legacy", configuredSubjectToken(scenario)],
        [
          "immutable",
          configuredSubjectToken(scenario, {
            sub: `repo:${scenario.repository.replace("/", "@555555/")}@123456789:ref:${scenario.ref}`,
          }),
        ],
        ["customized", configuredSubjectToken(scenario, { sub: `custom:${scenario.name}` })],
        ["missing", withoutClaim(configuredSubjectToken(scenario), "sub")],
        ["malformed", configuredSubjectToken(scenario, { sub: 123 })],
      ] as const;

      for (const [subForm, subjectToken] of subjectTokens) {
        expect(
          tokenIssuancePolicyPermits(
            configuredTokenIssuancePolicy,
            subjectToken,
            configuredRequest(scenario, scenario.permissions),
          ),
          `${scenario.name}: ${subForm}`,
        ).toBe(true);
      }
    }
  });
});

function withoutClaim<
  ClaimName extends string,
  SubjectToken extends ReturnType<typeof configuredSubjectToken>,
>(subjectToken: SubjectToken, claimName: ClaimName): SubjectToken {
  const claims = { ...subjectToken.claims };
  delete claims[claimName];

  return { ...subjectToken, claims: Object.freeze(claims) };
}
