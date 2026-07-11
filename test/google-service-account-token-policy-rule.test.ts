import { describe, expect, it } from "vitest";

import { googleServiceAccountTrustedIssuer } from "@cyspbot/oidc-issuer-google-service-account";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";
import { googleServiceAccountInstallationTokenRule } from "@cyspbot/token-exchange/policy/google-service-account-token-policy-rule";
import {
  evaluateConfiguredTokenPolicy,
  normalizeInstallationAccessTokenRequest,
  validateTokenPolicyRules,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";

const resource = "https://api.github.com/repos/fixture-owner/fixture-repository";
const permissions = { contents: "write" };
const uniqueId = "107517467455664443765";
const email = "fixture@fixture-project.iam.gserviceaccount.com";
const claims = { azp: uniqueId, email, email_verified: true, sub: uniqueId };

describe("Google service-account installation-token policy rules", () => {
  it("allows an exact service-account unique ID", () => {
    const rule = googleRule();

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
  });

  it("optionally requires the verified service-account email", () => {
    const rule = googleRule({ email });

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
    expect(evaluate(rule, { ...claims, email_verified: false })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("denies a different unique ID, resource, or permissions", () => {
    expect(evaluate(googleRule(), { ...claims, azp: "other-id", sub: "other-id" })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
    expect(
      evaluate(googleRule(), claims, {
        resource: "https://api.github.com/repos/fixture-owner/other-repository",
      }),
    ).toEqual({ decision: "deny", reasons: ["resource"] });
    expect(evaluate(googleRule(), claims, { scope: "contents:read" })).toEqual({
      decision: "deny",
      reasons: ["permissions"],
    });
  });

  it("rejects empty policy identity fields", () => {
    expect(() => googleRule({ uniqueId: "" })).toThrow(
      "Google service-account policy rule requires a unique ID",
    );
    expect(() => googleRule({ email: "" })).toThrow(
      "Google service-account policy rule email must not be empty",
    );
  });
});

function googleRule(
  overrides: Partial<Parameters<typeof googleServiceAccountInstallationTokenRule>[0]> = {},
): TokenPolicyRule {
  return googleServiceAccountInstallationTokenRule({
    id: "test-google-service-account",
    permissions,
    resource,
    uniqueId,
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
    issuer: googleServiceAccountTrustedIssuer.issuer,
    resolvedKeyId: "google-key",
    subjectTokenType: "id_token",
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
