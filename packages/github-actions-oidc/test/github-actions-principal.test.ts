import { describe, expect, it } from "vitest";

import {
  deriveGitHubActionsPrincipal,
  parseGitHubActionsClaims,
} from "../src/github-actions-principal.ts";

const claims = {
  actor: "dependabot[bot]",
  event_name: "workflow_dispatch",
  ref: "refs/heads/fixture-base-branch",
  ref_type: "branch",
  repository: "fixture-owner/fixture-source-repository",
  repository_id: "123456789",
  repository_owner_id: "555555",
  repository_visibility: "private",
  run_attempt: "1",
  run_id: "987654321",
  sha: "0123456789abcdef0123456789abcdef01234567",
  sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
  workflow: "fixture token request",
  workflow_ref:
    "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
};

describe("GitHub Actions OIDC principal derivation", () => {
  it("derives a principal from legacy branch subjects", () => {
    const parsedClaims = parseGitHubActionsClaims(claims);
    expect(parsedClaims).not.toBeNull();

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toEqual({
      actor: "dependabot[bot]",
      eventName: "workflow_dispatch",
      rawSubject: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
      ref: "refs/heads/fixture-base-branch",
      refType: "branch",
      repository: "fixture-owner/fixture-source-repository",
      repositoryId: "123456789",
      repositoryOwnerId: "555555",
      repositoryVisibility: "private",
      runAttempt: "1",
      runId: "987654321",
      sha: "0123456789abcdef0123456789abcdef01234567",
      subject: {
        kind: "ref",
        raw: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
        ref: "refs/heads/fixture-base-branch",
        repositorySubject: "fixture-owner/fixture-source-repository",
      },
      workflow: "fixture token request",
      workflowRef:
        "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
    });
  });

  it("derives a principal from immutable branch subjects", () => {
    const parsedClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal?.subject).toEqual({
      kind: "ref",
      raw: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      ref: "refs/heads/fixture-base-branch",
      repositorySubject: "fixture-owner@555555/fixture-source-repository@123456789",
    });
  });

  it("validates claim shape before principal derivation", () => {
    expect(
      parseGitHubActionsClaims({
        ...claims,
        actor: 123,
      }),
    ).toBeNull();

    expect(
      parseGitHubActionsClaims({
        ...claims,
        ref_type: undefined,
      }),
    ).toBeNull();
  });

  it("rejects malformed subject encoding", () => {
    const parsedClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:fixture-owner%ZZ/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toBeNull();
  });

  it("rejects legacy subjects whose repository does not match the repository claim", () => {
    const parsedClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:fixture-owner/fixture-other-repository:ref:refs/heads/fixture-base-branch",
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toBeNull();
  });

  it.each([
    [
      "repository name",
      {
        sub: "repo:fixture-owner@555555/fixture-other-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
    [
      "repository id",
      {
        sub: "repo:fixture-owner@555555/fixture-source-repository@987654321:ref:refs/heads/fixture-base-branch",
      },
    ],
    [
      "owner id",
      {
        sub: "repo:fixture-owner@999999/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
  ])("rejects immutable subjects whose %s does not match claims", (_caseName, patch) => {
    const parsedClaims = parseGitHubActionsClaims({
      ...claims,
      ...patch,
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toBeNull();
  });

  it("parses pull request and environment subjects for policy denial", () => {
    const pullRequestClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:fixture-owner/fixture-source-repository:pull_request",
    });
    const environmentClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:fixture-owner/fixture-source-repository:environment:Production%3AV1",
    });

    expect(
      pullRequestClaims === null ? null : deriveGitHubActionsPrincipal(pullRequestClaims)?.subject,
    ).toEqual({
      kind: "pull_request",
      raw: "repo:fixture-owner/fixture-source-repository:pull_request",
      repositorySubject: "fixture-owner/fixture-source-repository",
    });
    expect(
      environmentClaims === null ? null : deriveGitHubActionsPrincipal(environmentClaims)?.subject,
    ).toEqual({
      environment: "Production:V1",
      kind: "environment",
      raw: "repo:fixture-owner/fixture-source-repository:environment:Production%3AV1",
      repositorySubject: "fixture-owner/fixture-source-repository",
    });
  });
});
