import { describe, expect, it } from "vitest";

import { classifyStatusReactionJob } from "../workers/cyspbot-github-webhook-receiver/src/github-webhooks/status-reaction.ts";

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
});
