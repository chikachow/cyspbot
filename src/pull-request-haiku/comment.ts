import type { GitHubPullRequestDetails } from "../github/pull-request.ts";

export interface PullRequestCommentInput {
  haiku: PullRequestHaiku;
  pullRequest: GitHubPullRequestDetails;
  repositoryId: number;
}

export interface PullRequestHaiku {
  text: string;
}

export function pullRequestHaikuCommentMarker(input: {
  pullRequestNumber: number;
  repositoryId: number;
}): string {
  return `<!-- cyspbot:pull-request-haiku repository_id=${input.repositoryId} pull_request=${input.pullRequestNumber} -->`;
}

export function renderPullRequestHaikuComment(input: PullRequestCommentInput): string {
  const marker = pullRequestHaikuCommentMarker({
    pullRequestNumber: input.pullRequest.number,
    repositoryId: input.repositoryId,
  });

  return `${marker}
<p align="center">
  <em>${haikuHtml(input.haiku.text)}</em>
</p>`;
}

export function fallbackPullRequestHaiku(): PullRequestHaiku {
  return {
    text: "Quiet changes wait\nBranches lean toward review\nMorning tests awake",
  };
}

function haikuHtml(haiku: string): string {
  return haiku
    .split("\n")
    .map((line) => escapeHtml(line.trim()))
    .filter((line) => line.length > 0)
    .join("<br>\n  ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
