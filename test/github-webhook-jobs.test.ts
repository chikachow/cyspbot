import { describe, expect, it } from "vitest";

import { parseGitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";

describe("GitHub webhook jobs", () => {
  it("parses the versioned status-reaction job", () => {
    expect(
      parseGitHubIssueCommentStatusReactionJob({
        commentId: 42,
        deliveryId: "delivery-123",
        kind: "github.issue-comment.status-reaction",
        repository: {
          name: "cyspbot",
          owner: "chikachow",
        },
        version: 1,
      }),
    ).toEqual({
      commentId: 42,
      deliveryId: "delivery-123",
      kind: "github.issue-comment.status-reaction",
      repository: {
        name: "cyspbot",
        owner: "chikachow",
      },
      version: 1,
    });
  });

  it.each([
    ["an unknown version", { version: 2 }],
    ["an extra property", { unexpected: true }],
    ["an empty delivery id", { deliveryId: " " }],
    ["a path separator in the repository", { repository: { name: "repo/name", owner: "owner" } }],
    ["a repository fragment", { repository: { name: "repo#name", owner: "owner" } }],
    [
      "a control character in the repository",
      { repository: { name: "repo\u0001name", owner: "owner" } },
    ],
    ["a non-positive comment id", { commentId: 0 }],
  ])("rejects %s", (_name, override) => {
    expect(
      parseGitHubIssueCommentStatusReactionJob({
        commentId: 42,
        deliveryId: "delivery-123",
        kind: "github.issue-comment.status-reaction",
        repository: {
          name: "cyspbot",
          owner: "chikachow",
        },
        version: 1,
        ...override,
      }),
    ).toBeUndefined();
  });
});
