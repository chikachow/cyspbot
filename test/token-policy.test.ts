import { describe, expect, it } from "vitest";

import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { evaluateTokenPolicy } from "@cyspbot/token-exchange/policy/token-policy";

const repository = {
  defaultBranch: "main",
  repository: "cysp/terraform-provider-contentful",
  repositoryId: "123456789",
  repositoryOwnerId: "555555",
  repositoryVisibility: "private",
};

const principal: GitHubActionsPrincipal = {
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
};

describe("Token Policy", () => {
  it("allows default-branch workflow dispatch with PR-authoring permissions", () => {
    const decision = evaluateTokenPolicy(principal, repository);

    expect(decision).toEqual({
      decision: "allow",
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
      reasons: [],
    });
  });

  it("allows default-branch schedule with PR-authoring permissions", () => {
    const decision = evaluateTokenPolicy(
      {
        ...principal,
        eventName: "schedule",
      },
      repository,
    );

    expect(decision).toMatchObject({
      decision: "allow",
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
    });
  });

  it("denies push while preserving the event type", () => {
    const decision = evaluateTokenPolicy(
      {
        ...principal,
        eventName: "push",
      },
      repository,
    );

    expect(decision).toEqual({
      decision: "deny",
      reasons: ["event_name"],
    });
  });

  it("does not currently authorize by workflow path", () => {
    const decision = evaluateTokenPolicy(
      {
        ...principal,
        jobWorkflowRef:
          "cysp/terraform-provider-contentful/.github/workflows/release.yml@refs/heads/main",
        workflowRef:
          "cysp/terraform-provider-contentful/.github/workflows/release.yml@refs/heads/main",
      },
      repository,
    );

    expect(decision).toMatchObject({ decision: "allow" });
  });

  it("denies trusted workflow files on non-default refs", () => {
    const decision = evaluateTokenPolicy(
      {
        ...principal,
        jobWorkflowRef:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/feature",
        ref: "refs/heads/feature",
        rawSubject: "repo:cysp/terraform-provider-contentful:ref:refs/heads/feature",
        subject: {
          kind: "ref",
          raw: "repo:cysp/terraform-provider-contentful:ref:refs/heads/feature",
          ref: "refs/heads/feature",
          repositorySubject: "cysp/terraform-provider-contentful",
        },
        workflowRef:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/feature",
      },
      repository,
    );

    expect(decision).toEqual({
      decision: "deny",
      reasons: ["sub", "ref"],
    });
  });

  it("allows immutable subject repository components when signed repository claims match", () => {
    const decision = evaluateTokenPolicy(
      {
        ...principal,
        rawSubject: "repo:cysp@555555/terraform-provider-contentful@123456789:ref:refs/heads/main",
        subject: {
          kind: "ref",
          raw: "repo:cysp@555555/terraform-provider-contentful@123456789:ref:refs/heads/main",
          ref: "refs/heads/main",
          repositorySubject: "cysp@555555/terraform-provider-contentful@123456789",
        },
      },
      repository,
    );

    expect(decision).toMatchObject({
      decision: "allow",
    });
  });
});
