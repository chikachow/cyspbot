import {
  parseGitHubIssueCommentStatusReactionJob,
  type GitHubIssueCommentStatusReactionJob,
} from "@cyspbot/github-webhook-jobs";

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
  if (!isRecord(owner)) return undefined;

  return parseGitHubIssueCommentStatusReactionJob({
    commentId: comment["id"],
    deliveryId,
    kind: "github.issue-comment.status-reaction",
    repository: {
      name: repository["name"],
      owner: owner["login"],
    },
    version: 1,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
