import { describe, expect, it } from "vitest";
import { parseGitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";

import { classifyStatusReactionJob } from "../src/github-webhooks/status-reaction.ts";

const matchingPayload = {
  action: "created",
  comment: {
    body: "/cyspbot status",
    id: 42,
  },
  repository: {
    name: "cyspbot",
    owner: {
      login: "chikachow",
    },
  },
};

describe("GitHub status reaction classification", () => {
  it.each([
    ["a different action", { ...matchingPayload, action: "edited" }],
    ["a different comment", { ...matchingPayload, comment: { body: "/cyspbot help", id: 42 } }],
    ["a missing repository", { ...matchingPayload, repository: null }],
    [
      "a missing repository owner",
      { ...matchingPayload, repository: { name: "cyspbot", owner: null } },
    ],
    [
      "an invalid comment id",
      { ...matchingPayload, comment: { ...matchingPayload.comment, id: 0 } },
    ],
    [
      "an invalid repository owner",
      {
        ...matchingPayload,
        repository: { name: "cyspbot", owner: { login: "" } },
      },
    ],
    [
      "an invalid repository name",
      { ...matchingPayload, repository: { name: "", owner: { login: "chikachow" } } },
    ],
  ])("ignores %s", (_name, payload) => {
    expect(classifyStatusReactionJob("issue_comment", "delivery-123", payload)).toBeUndefined();
  });
  it.each(["repo/name", "repo\\name", "repo?name", "repo#name", "repo\u0001name", "x".repeat(101)])(
    "does not enqueue an invalid repository part: %j",
    (name) => {
      for (const repository of [
        { name, owner: { login: "owner" } },
        { name: "repo", owner: { login: name } },
      ]) {
        expect(
          classifyStatusReactionJob("issue_comment", "delivery-123", {
            ...matchingPayload,
            repository,
          }),
        ).toBeUndefined();
      }
    },
  );

  it("does not enqueue an empty delivery id", () => {
    expect(classifyStatusReactionJob("issue_comment", " ", matchingPayload)).toBeUndefined();
  });

  it.each(["repo", "repo.name", "repo-name", "repo_name", "x".repeat(100)])(
    "emits a consumer-valid job for %s",
    (name) => {
      const job = classifyStatusReactionJob("issue_comment", "delivery-123", {
        ...matchingPayload,
        repository: { name, owner: { login: "owner" } },
      });
      expect(job).toEqual({
        commentId: 42,
        deliveryId: "delivery-123",
        kind: "github.issue-comment.status-reaction",
        repository: { owner: "owner", name },
        version: 1,
      });
      expect(parseGitHubIssueCommentStatusReactionJob(job)).toEqual(job);
    },
  );
});
