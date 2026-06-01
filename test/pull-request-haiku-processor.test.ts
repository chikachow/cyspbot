import { describe, expect, it } from "vitest";

import { GitHubApiError } from "../src/github/http.ts";
import {
  processPullRequestHaikuMessage,
  type PullRequestHaikuDependencies,
  type PullRequestHaikuGitHubClient,
  type PullRequestHaikuStore,
} from "../src/pull-request-haiku/processor.ts";
import { testEnv } from "./support/worker.ts";

describe("pull request haiku processor", () => {
  it("runs through injected storage, GitHub, and AI services", async () => {
    const calls: string[] = [];
    const store: PullRequestHaikuStore = {
      getCommentState: async () => null,
      markRunFailed: async () => {
        calls.push("failed");
      },
      markRunSkipped: async () => {
        calls.push("skipped");
      },
      markRunStarted: async (_env, input) => {
        calls.push(`started:${input.deliveryId}:${input.startedAt}`);
      },
      markRunSucceeded: async (_env, input) => {
        calls.push(`succeeded:${input.deliveryId}:${input.commentId}:${input.aiModel}`);
        expect(input).toMatchObject({
          deliveryId: "delivery-pr-queue",
          headSha: "abc123def456abc123def456abc123def456abcd",
          outputKind: "markdown",
          pullRequestNumber: 12,
          repositoryId: 123456789,
        });
      },
    };
    const github: PullRequestHaikuGitHubClient = {
      createInstallationToken: async (_env, installationId, repositoryId) => {
        expect({ installationId, repositoryId }).toEqual({
          installationId: 67890,
          repositoryId: 123456789,
        });
        return { token: "ghs_test_pr_ai_token" };
      },
      createIssueComment: async (_env, input) => {
        calls.push("create-comment");
        expect(input.body).toContain("cyspbot:pull-request-haiku");
        expect(input.body).toContain("Injected spring rain");
        expect(input.installationToken).toBe("ghs_test_pr_ai_token");
        expect(input.pullRequestNumber).toBe(12);
        expect(input.repositoryFullName).toBe("cysp/terraform-provider-contentful");
        return { body: input.body, id: 987654 };
      },
      getPullRequestDetails: async () => ({
        additions: 120,
        changedFiles: 1,
        deletions: 30,
        headSha: "abc123def456abc123def456abc123def456abcd",
        number: 12,
      }),
      listIssueComments: async () => [],
      listPullRequestChangedFiles: async () => [
        {
          additions: 80,
          changes: 90,
          deletions: 10,
          filename: "src/worker/app.ts",
          patch: "@@ -1,3 +1,4 @@\n+const seam = true;",
          status: "modified",
        },
      ],
      updateIssueComment: async () => {
        throw new GitHubApiError(500, "unexpected update");
      },
    };
    const dependencies: PullRequestHaikuDependencies = {
      fetch: fetch,
      generatePullRequestHaiku: async (_env, input) => {
        calls.push(`generate:${input.kind}`);
        return {
          haiku: {
            items: [
              {
                style: "haiku",
                text: "Injected spring rain\nDiffs gather into one song\nReview wakes gently",
              },
            ],
          },
          model: "google/gemini-2.5-flash",
        };
      },
      github,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
      store,
    };

    await processPullRequestHaikuMessage(
      testEnv,
      {
        action: "synchronize",
        deliveryId: "delivery-pr-queue",
        enqueuedAt: "2026-05-24T00:00:00.000Z",
        headSha: "abc123def456abc123def456abc123def456abcd",
        installationId: 67890,
        pullRequestNumber: 12,
        repositoryFullName: "cysp/terraform-provider-contentful",
        repositoryId: 123456789,
      },
      dependencies,
    );

    expect(calls).toEqual([
      "started:delivery-pr-queue:2026-05-24T00:00:00.000Z",
      "generate:diff_full",
      "create-comment",
      "succeeded:delivery-pr-queue:987654:google/gemini-2.5-flash",
    ]);
  });
});
