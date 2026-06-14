import { describe, expect, it } from "vitest";

import {
  deriveGitHubActionsPrincipal,
  parseGitHubActionsClaims,
} from "../src/github-actions-principal.ts";

const claims = {
  actor: "dependabot[bot]",
  event_name: "workflow_dispatch",
  job_workflow_ref:
    "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  ref: "refs/heads/main",
  ref_type: "branch",
  repository: "cysp/terraform-provider-contentful",
  repository_id: "123456789",
  repository_owner_id: "555555",
  repository_visibility: "private",
  run_attempt: "1",
  run_id: "987654321",
  sha: "0123456789abcdef0123456789abcdef01234567",
  sub: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
  workflow: "update indirect dependencies",
  workflow_ref:
    "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
};

describe("GitHub Actions OIDC principal derivation", () => {
  it("derives a principal from legacy branch subjects", () => {
    const parsedClaims = parseGitHubActionsClaims(claims);
    expect(parsedClaims).not.toBeNull();

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toEqual({
      actor: "dependabot[bot]",
      eventName: "workflow_dispatch",
      jobWorkflowRef:
        "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
      rawSubject: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
      ref: "refs/heads/main",
      refType: "branch",
      repository: "cysp/terraform-provider-contentful",
      repositoryId: "123456789",
      repositoryOwnerId: "555555",
      repositoryVisibility: "private",
      runAttempt: "1",
      runId: "987654321",
      sha: "0123456789abcdef0123456789abcdef01234567",
      subject: {
        kind: "ref",
        raw: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
        ref: "refs/heads/main",
        repositorySubject: "cysp/terraform-provider-contentful",
      },
      workflow: "update indirect dependencies",
      workflowRef:
        "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
    });
  });

  it("derives a principal from immutable branch subjects", () => {
    const parsedClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:cysp@555555/terraform-provider-contentful@123456789:ref:refs/heads/main",
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal?.subject).toEqual({
      kind: "ref",
      raw: "repo:cysp@555555/terraform-provider-contentful@123456789:ref:refs/heads/main",
      ref: "refs/heads/main",
      repositorySubject: "cysp@555555/terraform-provider-contentful@123456789",
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
      sub: "repo:cysp%ZZ/terraform-provider-contentful:ref:refs/heads/main",
    });

    const principal = parsedClaims === null ? null : deriveGitHubActionsPrincipal(parsedClaims);

    expect(principal).toBeNull();
  });

  it("parses pull request and environment subjects for policy denial", () => {
    const pullRequestClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:cysp/terraform-provider-contentful:pull_request",
    });
    const environmentClaims = parseGitHubActionsClaims({
      ...claims,
      sub: "repo:cysp/terraform-provider-contentful:environment:Production%3AV1",
    });

    expect(
      pullRequestClaims === null ? null : deriveGitHubActionsPrincipal(pullRequestClaims)?.subject,
    ).toEqual({
      kind: "pull_request",
      raw: "repo:cysp/terraform-provider-contentful:pull_request",
      repositorySubject: "cysp/terraform-provider-contentful",
    });
    expect(
      environmentClaims === null ? null : deriveGitHubActionsPrincipal(environmentClaims)?.subject,
    ).toEqual({
      environment: "Production:V1",
      kind: "environment",
      raw: "repo:cysp/terraform-provider-contentful:environment:Production%3AV1",
      repositorySubject: "cysp/terraform-provider-contentful",
    });
  });
});
