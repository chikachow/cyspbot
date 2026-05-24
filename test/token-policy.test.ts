import { describe, expect, it } from "vitest";

import type { GitHubActionsPrincipal } from "../src/oidc/principals.ts";
import { evaluateTokenPolicy } from "../src/policy/token-policy.ts";

const repository = {
  defaultBranch: "main",
  repository: "cysp/terraform-provider-contentful",
  repositoryId: "123456789",
  repositoryOwnerId: "555555",
  repositoryVisibility: "private",
};

const principal: GitHubActionsPrincipal = {
  actor: "dependabot[bot]",
  baseRef: "",
  environment: null,
  eventName: "workflow_dispatch",
  headRef: "",
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
  subjectContextKind: "ref",
  subjectContextValue: "refs/heads/main",
  subjectRepository: "cysp/terraform-provider-contentful",
  type: "github-actions",
  workflow: "update indirect dependencies",
  workflowRef:
    "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
};

describe("Token Policy", () => {
  it("allows default-branch workflow dispatch with PR-authoring permissions", () => {
    const decision = evaluateTokenPolicy(principal, repository);

    expect(decision).toEqual({
      decision: "allow",
      eventType: "workflow_dispatch",
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
      eventType: "schedule",
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
      eventType: "push",
      reasons: ["event_not_allowed"],
    });
  });
});
