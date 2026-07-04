import type { GitHubActionsPrincipal } from "@cyspbot/github-actions-oidc/principals";
import { describe, expect, it, vi } from "vitest";

import { issueInstallationTokenForContext } from "../workers/cyspbot-token-exchange/src/policy/installation-token-issuance.ts";
import {
  testRepository,
  testInstallationId,
  testRepositoryId,
  testRepositoryOwnerId,
  testRepositoryVisibility,
} from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { testTokenPolicyRules } from "./support/token-policy.ts";
import { testEnv } from "./support/worker-env.ts";

const principal: GitHubActionsPrincipal = {
  actor: "dependabot[bot]",
  eventName: "workflow_dispatch",
  rawSubject: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
  ref: "refs/heads/fixture-base-branch",
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
    raw: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    ref: "refs/heads/fixture-base-branch",
    repositorySubject: testRepository,
  },
  workflow: "fixture token request",
  workflowRef:
    "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
};

describe("installation token issuance", () => {
  it("rejects installation token requests that select extra repositories", async () => {
    const response = await fetchGitHubTestDouble(
      `https://api.github.com/app/installations/${testInstallationId}/access_tokens`,
      {
        body: JSON.stringify({
          permissions: {
            contents: "write",
            pull_requests: "write",
          },
          repositories: ["fixture-source-repository", "fixture-extra-repository"],
        }),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "x-github-stateless-s2s-token": "enabled",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(500);
  });

  it("does not fetch source repository metadata before minting", async () => {
    const requestedPaths: string[] = [];

    await expect(
      issueInstallationTokenForContext(
        testEnv,
        {
          issuer: "https://token.actions.githubusercontent.com",
          principal,
          resolvedKeyId: "test-key-1",
        },
        {
          permissions: {
            contents: "write",
            pull_requests: "write",
          },
          resource: new URL("https://api.github.com/repos/fixture-owner/fixture-source-repository"),
          scope: "contents:write pull_requests:write",
        },
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);

            requestedPaths.push(url.pathname);

            if (request.method === "GET" && url.pathname === `/repos/${testRepository}`) {
              throw new Error("source repository metadata should not be fetched");
            }

            return fetchGitHubTestDouble(input, init);
          },
          tokenPolicyRules: testTokenPolicyRules,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(requestedPaths).not.toContain(`/repos/${testRepository}`);
  });

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
          {
            permissions: {
              contents: "write",
              pull_requests: "write",
            },
            resource: new URL(
              "https://api.github.com/repos/fixture-owner/fixture-source-repository",
            ),
            scope: "contents:write pull_requests:write",
          },
          { fetch: fetchGitHubTestDouble, tokenPolicyRules: testTokenPolicyRules },
        ),
      ).resolves.toMatchObject({
        ok: true,
        token: "ghs_test_token",
      });
    } finally {
      console.info = originalInfo;
    }

    expect(consoleInfo).toHaveBeenCalledWith({
      event: "installation_token_issuance_succeeded",
      expires_at: "2030-01-01T00:00:00Z",
      principal: expect.objectContaining({
        actor: "dependabot[bot]",
        event_name: "workflow_dispatch",
        issuer: "https://token.actions.githubusercontent.com",
        repository: testRepository,
        repository_id: testRepositoryId,
        repository_owner_id: testRepositoryOwnerId,
        repository_visibility: testRepositoryVisibility,
        resolved_key_id: "test-key-1",
        sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
      }),
      target_installation: {
        id: 67890,
        repository: testRepository,
      },
      token_policy: {
        matched: true,
        rule: expect.objectContaining({
          principalRepository: testRepository,
          resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
        }),
      },
      token_request: {
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
        scope: "contents:write pull_requests:write",
      },
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toContain("ghs_test_token");
  });
});
