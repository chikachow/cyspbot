import { githubActionsTrustedIssuer } from "@cyspbot/oidc-issuer-github-actions";
import {
  normalizeInstallationAccessTokenRequest,
  parseGitHubRepositoryResource,
  type GitHubRepositoryResource,
  type InstallationAccessTokenRequest,
} from "@cyspbot/token-exchange/installation-token-request";
import { createVerifiedSubjectToken } from "./oidc.ts";

export const fixtureRef = "refs/heads/fixture-base-branch";
export const fixtureSourceRepository = "fixture-owner/fixture-source-repository";
export const fixtureSourceResource = `https://api.github.com/repos/${fixtureSourceRepository}`;
export const fixtureTargetResource =
  "https://api.github.com/repos/fixture-target-owner/fixture-target-repository";

const fixtureWorkflowRef = `${fixtureSourceRepository}/.github/workflows/fixture-token-request.yml@${fixtureRef}`;

export const subjectToken = createVerifiedSubjectToken(
  {
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
  { issuer: githubActionsTrustedIssuer.issuer, resolvedKeyId: "fixture-key" },
);

export function sameRepositoryTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest({
    resource: fixtureSourceResource,
    scope: null,
  });
}

export function crossOwnerActionsTokenRequest(): InstallationAccessTokenRequest {
  return mustNormalizeTokenRequest({
    resource: fixtureTargetResource,
    scope: "actions:write",
  });
}

export function mustNormalizeTokenRequest(options: {
  resource: string;
  scope: string | null;
}): InstallationAccessTokenRequest {
  const result = normalizeInstallationAccessTokenRequest({
    resource: options.resource,
    scope: options.scope,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.tokenRequest;
}

export function mustParseRepositoryResource(value: string): GitHubRepositoryResource {
  const resource = parseGitHubRepositoryResource(value);

  if (resource === null) {
    throw new Error("invalid fixture repository resource");
  }

  return resource;
}
