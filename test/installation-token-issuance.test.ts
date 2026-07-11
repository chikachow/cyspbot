import { describe, expect, it, vi } from "vitest";
import type { VerifiedSubjectToken } from "@cyspbot/token-exchange/authentication";

import { issueInstallationTokenForContext } from "../workers/cyspbot-token-exchange/src/policy/installation-token-issuance.ts";
import { testRepository, testInstallationId } from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { testTokenPolicyRules } from "./support/token-policy.ts";
import { testEnv } from "./support/worker-env.ts";

const subjectToken: VerifiedSubjectToken = {
  claims: {
    actor: "dependabot[bot]",
    event_name: "workflow_dispatch",
    ref: "refs/heads/fixture-base-branch",
    ref_type: "branch",
    repository: testRepository,
    sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    workflow_ref:
      "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
  },
  issuer: "https://token.actions.githubusercontent.com",
  resolvedKeyId: "test-key-1",
  subjectTokenType: "id_token",
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
          subjectToken,
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
            subjectToken,
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
      subject_token: expect.objectContaining({
        issuer: "https://token.actions.githubusercontent.com",
        resolved_key_id: "test-key-1",
        sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
        subject_token_type: "id_token",
      }),
      target_installation: {
        id: 67890,
        repository: testRepository,
      },
      token_policy: {
        matched: true,
        rule_id: "test-github-same-repository",
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
