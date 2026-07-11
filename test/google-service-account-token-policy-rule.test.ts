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
import { createVerifiedSubjectToken } from "./support/oidc.ts";

const resource = "https://api.github.com/repos/fixture-owner/fixture-repository";
const permissions = { contents: "write" };
const uniqueId = "107517467455664443765";
const email = "fixture@fixture-project.iam.gserviceaccount.com";
const claims = { azp: uniqueId, email, email_verified: true, sub: uniqueId };

describe("Google service account installation-token policy rules", () => {
  it("allows an exact service account unique ID", () => {
    const rule = googleRule();

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
    expect(evaluate(rule, { ...claims, azp: "not-selected-by-policy" })).toEqual({
      decision: "allow",
      matchedRule: rule,
    });
  });

  it("denies a different service account unique ID", () => {
    expect(evaluate(googleRule(), { ...claims, sub: "other-id" })).toEqual({
      decision: "deny",
      reasons: ["condition"],
    });
  });

  it("optionally requires an exact verified service account email", () => {
    const rule = googleRule({ email });
    const { email_verified: _emailVerified, ...claimsWithoutEmailVerification } = claims;

    expect(evaluate(rule, claims)).toEqual({ decision: "allow", matchedRule: rule });
    for (const candidateClaims of [
      { ...claims, email: "different@fixture-project.iam.gserviceaccount.com" },
      { ...claims, email_verified: false },
      { ...claims, email_verified: "true" },
      claimsWithoutEmailVerification,
    ]) {
      expect(evaluate(rule, candidateClaims)).toEqual({
        decision: "deny",
        reasons: ["condition"],
      });
    }
  });

  it("does not select email claims unless the rule configures an email", () => {
    const rule = googleRule();

    expect(evaluate(rule, { sub: uniqueId })).toEqual({
      decision: "allow",
      matchedRule: rule,
    });
  });

  it("denies a different repository resource or permissions", () => {
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

  it("rejects an omitted repository resource for a Google subject token", () => {
    expect(
      normalizeInstallationAccessTokenRequest(googleSubjectToken(claims), {
        resource: null,
        scope: "contents:write",
      }),
    ).toEqual({ error: "invalid_target", ok: false });
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
  const subjectToken = googleSubjectToken(tokenClaims);
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

function googleSubjectToken(tokenClaims: Record<string, unknown>): VerifiedSubjectToken {
  return createVerifiedSubjectToken(tokenClaims, {
    issuer: googleServiceAccountTrustedIssuer.issuer,
    resolvedKeyId: "google-key",
  });
}
