import { githubActionsTrustedIssuer } from "@cyspbot/oidc-issuer-github-actions";
import {
  normalizeInstallationAccessTokenRequest,
  type InstallationAccessTokenRequest,
  type TokenPolicyRule,
} from "@cyspbot/token-exchange/policy/token-policy";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";

export const fixtureRef = "refs/heads/fixture-base-branch";
export const fixtureSourceRepository = "fixture-owner/fixture-source-repository";
export const fixtureSourceResource = `https://api.github.com/repos/${fixtureSourceRepository}`;
export const fixtureTargetResource =
  "https://api.github.com/repos/fixture-target-owner/fixture-target-repository";

const fixtureWorkflowRef = `${fixtureSourceRepository}/.github/workflows/fixture-token-request.yml@${fixtureRef}`;

export const subjectToken: VerifiedSubjectToken = {
  claims: {
    actor: "dependabot[bot]",
    event_name: "workflow_dispatch",
    ref: fixtureRef,
    ref_type: "branch",
    repository: fixtureSourceRepository,
    repository_id: "123456789",
    repository_owner_id: "555555",
    repository_visibility: "private",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    sub: `repo:${fixtureSourceRepository}:ref:${fixtureRef}`,
    workflow: "fixture token request",
    workflow_ref: fixtureWorkflowRef,
  },
  issuer: githubActionsTrustedIssuer.issuer,
  resolvedKeyId: "fixture-key",
  subjectTokenType: "id_token",
};

export function sameRepositoryTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest(subjectToken, {
    resource: null,
    scope: null,
  });
}

export function crossOwnerActionsTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest(subjectToken, {
    resource: fixtureTargetResource,
    scope: "actions:write",
  });
}

export function mustNormalizeTokenRequest(
  testSubjectToken: VerifiedSubjectToken,
  options: { resource: string | null; scope: string | null },
): InstallationAccessTokenRequest {
  const result = normalizeInstallationAccessTokenRequest(testSubjectToken, {
    resource: options.resource,
    scope: options.scope,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.tokenRequest;
}

export function subjectTokenForRule(
  rule: TokenPolicyRule,
  options: {
    eventName?: string;
    ref?: string;
    repository?: string;
    workflowRef?: string;
  } = {},
): VerifiedSubjectToken {
  const ref = options.ref ?? claimStringFromCondition(rule.when, "ref") ?? fixtureRef;
  const repository =
    options.repository ??
    claimStringFromCondition(rule.when, "repository") ??
    fixtureSourceRepository;

  return {
    ...subjectToken,
    claims: {
      ...subjectToken.claims,
      event_name: options.eventName ?? "workflow_dispatch",
      ref,
      repository,
      sub: `repo:${repository}:ref:${ref}`,
      workflow_ref:
        options.workflowRef ??
        claimStringFromCondition(rule.when, "workflow_ref") ??
        `${repository}/.github/workflows/fixture-token-request.yml@${ref}`,
    },
  };
}

function claimStringFromCondition(condition: string, claim: string): string | null {
  const match = new RegExp(`claims\\["${claim}"\\] == "([^"]+)"`, "u").exec(condition);

  return match?.[1] ?? null;
}
