import { describe, expect, it } from "vitest";

import {
  evaluateConfiguredTokenPolicy,
  normalizeInstallationAccessTokenRequest,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import { flyMachineInstallationTokenRule } from "@cyspbot/token-exchange/policy/fly-machine-token-policy-rule";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";

const issuer = "https://oidc.fly.io/example-org";
const resource = "https://api.github.com/repos/fixture-owner/fixture-repository";
const permissions = { contents: "write" };
const claims = {
  app_id: "fly-app-id",
  app_name: "fixture-app",
  machine_id: "fly-machine-id",
  machine_name: "fixture-machine",
  machine_version: "01KWR7P5J8EP4B0QJ0M3D4P5A6",
  org_id: "fly-org-id",
  org_name: "example-org",
  sub: "example-org:fixture-app:fixture-machine",
};

describe("Fly Machine installation-token policy rules", () => {
  it("allows an exact organization and app identity by immutable IDs", () => {
    const rule = flyRule();

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
  });

  it.each([
    ["organization", { org_id: "other-org-id" }],
    ["app", { app_id: "other-app-id" }],
  ])("denies a different %s identity", (_name, changedClaims) => {
    expect(evaluate(flyRule(), { ...claims, ...changedClaims })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it.each([
    ["issuer organization", { org_name: "other-org" }],
    ["canonical subject", { sub: "example-org:other-app:fixture-machine" }],
  ])("reasserts the %s binding at the policy boundary", (_name, changedClaims) => {
    expect(evaluate(flyRule(), { ...claims, ...changedClaims })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("optionally narrows a rule to one immutable Machine ID", () => {
    const rule = flyRule({ machineId: "fly-machine-id" });

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
    expect(evaluate(rule, { ...claims, machine_id: "other-machine-id" })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("denies a different repository resource", () => {
    expect(
      evaluate(flyRule(), claims, {
        resource: "https://api.github.com/repos/fixture-owner/other-repository",
      }),
    ).toEqual({ decision: "deny", reasons: ["resource"] });
  });

  it("denies a different permission request", () => {
    expect(evaluate(flyRule(), claims, { scope: "contents:read" })).toEqual({
      decision: "deny",
      reasons: ["permissions"],
    });
  });

  it("rejects empty policy identity fields", () => {
    expect(() => flyRule({ appId: "" })).toThrow(
      "Fly Machine policy rule requires organization slug, organization ID, and app ID",
    );
  });
});

function flyRule(
  overrides: Partial<Parameters<typeof flyMachineInstallationTokenRule>[0]> = {},
): TokenPolicyRule {
  return flyMachineInstallationTokenRule({
    appId: "fly-app-id",
    id: "test-fly-machine",
    orgId: "fly-org-id",
    orgSlug: "example-org",
    permissions,
    resource,
    ...overrides,
  });
}

function evaluate(
  rule: TokenPolicyRule,
  tokenClaims: Record<string, unknown>,
  request: { resource?: string; scope?: string } = {},
) {
  const subjectToken: VerifiedSubjectToken = {
    claims: tokenClaims,
    issuer,
    resolvedKeyId: "fly-key",
    subjectTokenType: "jwt",
  };
  const tokenRequest = normalizeInstallationAccessTokenRequest(subjectToken, {
    resource: request.resource ?? resource,
    scope: request.scope ?? "contents:write",
  });

  if (!tokenRequest.ok) {
    throw new Error("fixture token request did not normalize");
  }

  return evaluateConfiguredTokenPolicy(
    { subjectToken, tokenRequest: tokenRequest.tokenRequest },
    validateTokenPolicyRules([rule]),
  );
}
