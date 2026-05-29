import type { GitHubPullRequestDetails } from "../github/pull-request.ts";

export interface PullRequestCommentInput {
  costEstimate?: PullRequestHaikuCostEstimate;
  haiku: PullRequestHaiku;
  pullRequest: GitHubPullRequestDetails;
  repositoryId: number;
}

export type PullRequestCommentaryStyle =
  | "code_joke"
  | "commit_fortune"
  | "dry_release_note"
  | "haiku"
  | "original_song_line"
  | "sarcastic_summary"
  | "tiny_changelog";

export interface PullRequestHaiku {
  style: PullRequestCommentaryStyle;
  text: string;
}

export interface PullRequestHaikuCostEstimate {
  cachedInputTokens: number | null;
  estimatedCostUsd: number;
  estimatedNeurons: number;
  inputTokens: number;
  inputUsdPerMillionTokens: number;
  model: string;
  outputTokens: number;
  outputUsdPerMillionTokens: number;
  scope: "prompt";
  totalTokens: number | null;
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
  const costMarker =
    input.costEstimate === undefined
      ? ""
      : `\n<!-- cyspbot:pull-request-haiku-cost ${JSON.stringify(input.costEstimate)} -->`;

  return `${marker}${costMarker}
<p align="center">
  <em>${haikuHtml(input.haiku.text)}</em>
</p>`;
}

export function fallbackPullRequestHaiku(): PullRequestHaiku {
  return {
    style: "haiku",
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
