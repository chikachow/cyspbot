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

  it.each([".", "..", "high surrogate", "low surrogate"])(
    "rejects a repository part that cannot preserve its URL segment: %s",
    (example) => {
      const part = example.endsWith("surrogate")
        ? String.fromCharCode(example === "high surrogate" ? 0xd800 : 0xdfff)
        : example;
      for (const repository of [
        { owner: part, name: "repo" },
        { owner: "owner", name: part },
      ]) {
        expect(
          parseGitHubIssueCommentStatusReactionJob({
            commentId: 42,
            deliveryId: "delivery-123",
            kind: "github.issue-comment.status-reaction",
            repository,
            version: 1,
          }) === undefined,
        ).toBe(true);
      }
    },
  );

  it.each([".github", "...", "%2e", "caf\u00e9", "\ud83d\udc40"])(
    "preserves an encodable repository part without normalizing it: %j",
    (part) => {
      const job = {
        commentId: 42,
        deliveryId: "delivery-123",
        kind: "github.issue-comment.status-reaction",
        repository: { owner: part, name: part },
        version: 1,
      };
      expect(parseGitHubIssueCommentStatusReactionJob(job)).toEqual(job);
    },
  );

  it("does not substitute a non-enumerable expected property for an extra property", () => {
    const job = {
      commentId: 42,
      kind: "github.issue-comment.status-reaction",
      repository: { owner: "owner", name: "repo" },
      version: 1,
      unexpected: true,
    };
    Object.defineProperty(job, "deliveryId", { value: "delivery-123" });

    expect(parseGitHubIssueCommentStatusReactionJob(job)).toBeUndefined();
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
