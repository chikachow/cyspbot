import type { GitHubIssueCommentStatusReactionJob } from "@cyspbot/github-webhook-jobs";

export function classifyStatusReactionJob(
  event: string,
  deliveryId: string,
  payload: unknown,
): GitHubIssueCommentStatusReactionJob | undefined {
  if (event !== "issue_comment" || !isRecord(payload)) {
    return undefined;
  }

  if (payload["action"] !== "created") {
    return undefined;
  }

  const comment = payload["comment"];
  const repository = payload["repository"];
  if (
    !isRecord(comment) ||
    typeof comment["body"] !== "string" ||
    comment["body"].trim() !== "/cyspbot status" ||
    !isRecord(repository)
  ) {
    return undefined;
  }

  const owner = repository["owner"];
  const name = repository["name"];
  const commentId = comment["id"];

  if (
    !isRecord(owner) ||
    typeof owner["login"] !== "string" ||
    owner["login"].length === 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    !isSafeCommentId(commentId)
  ) {
    return undefined;
  }

  const job = {
    commentId,
    deliveryId,
    kind: "github.issue-comment.status-reaction",
    repository: {
      name,
      owner: owner["login"],
    },
    version: 1,
  } satisfies GitHubIssueCommentStatusReactionJob;

  return job;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCommentId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
