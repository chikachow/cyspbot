import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { describe, expect, it, vi } from "vitest";

import { issueInstallationTokenForContext } from "../workers/cyspbot-token-exchange/src/policy/installation-token-issuance.ts";
import {
  testInstallationId,
  testRepository,
  testRepositoryId,
  testRepositoryOwnerId,
  testRepositoryVisibility,
} from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { testEnv } from "./support/worker-env.ts";

const principal: GitHubActionsPrincipal = {
  actor: "dependabot[bot]",
  eventName: "workflow_dispatch",
  jobWorkflowRef:
    "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
  rawSubject: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
  ref: "refs/heads/main",
  refType: "branch",
  repository: testRepository,
  repositoryId: testRepositoryId,
  repositoryOwnerId: testRepositoryOwnerId,
  repositoryVisibility: testRepositoryVisibility,
  runAttempt: "1",
  runId: "987654321",
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: {
    kind: "ref",
    raw: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
    ref: "refs/heads/main",
    repositorySubject: testRepository,
  },
  workflow: "update indirect dependencies",
  workflowRef:
    "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
};

describe("installation token issuance", () => {
  it("logs GitHub Actions claims and issuance context on success", async () => {
    const originalInfo = console.info;
    const consoleInfo = vi.fn();
    console.info = consoleInfo;

    try {
      await expect(
        issueInstallationTokenForContext(
          testEnv,
          {
            issuer: "https://token.actions.githubusercontent.com",
            principal,
            resolvedKeyId: "test-key-1",
          },
          { fetch: fetchGitHubTestDouble },
        ),
      ).resolves.toMatchObject({
        ok: true,
        token: "ghs_test_token",
      });
    } finally {
      console.info = originalInfo;
    }

    expect(consoleInfo).toHaveBeenCalledWith(
      "Installation Token Issuance succeeded",
      expect.objectContaining({
        actor: "dependabot[bot]",
        event_name: "workflow_dispatch",
        installation_id: testInstallationId,
        issuer: "https://token.actions.githubusercontent.com",
        job_workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: testRepository,
        repository_id: testRepositoryId,
        repository_owner_id: testRepositoryOwnerId,
        repository_visibility: testRepositoryVisibility,
        resolved_key_id: "test-key-1",
        run_attempt: "1",
        run_id: "987654321",
        sha: "0123456789abcdef0123456789abcdef01234567",
        sub: "repo:cysp/terraform-provider-contentful:ref:refs/heads/main",
        subject_kind: "ref",
        workflow: "update indirect dependencies",
        workflow_ref:
          "cysp/terraform-provider-contentful/.github/workflows/update-indirect-dependencies.yml@refs/heads/main",
      }),
    );
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toContain("ghs_test_token");
  });
});
