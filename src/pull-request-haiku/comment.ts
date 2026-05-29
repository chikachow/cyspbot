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

export interface PullRequestCommentaryItem {
  style: PullRequestCommentaryStyle;
  text: string;
}

export interface PullRequestHaiku {
  items: PullRequestCommentaryItem[];
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
  const styleMarker = `\n<!-- cyspbot:pull-request-commentary-styles ${input.haiku.items.map((item) => item.style).join(",")} -->`;

  return `${marker}${costMarker}${styleMarker}
${input.haiku.items.map(commentaryItemHtml).join("\n\n")}`;
}

export function fallbackPullRequestHaiku(): PullRequestHaiku {
  return {
    items: [
      {
        style: "code_joke",
        text: "The diff walked into review and brought its test suite as a witness.",
      },
      {
        style: "commit_fortune",
        text: "Small changes, watched closely, become quiet confidence.",
      },
      {
        style: "dry_release_note",
        text: "Updates the pull request with bounded implementation changes.",
      },
      {
        style: "haiku",
        text: "Quiet changes wait\nBranches lean toward review\nMorning tests awake",
      },
      {
        style: "original_song_line",
        text: "The branch hums low while the checks find their rhythm.",
      },
      {
        style: "sarcastic_summary",
        text: "Another modest diff bravely asks the test suite to have opinions.",
      },
      {
        style: "tiny_changelog",
        text: "Changed: pull request implementation\nKept: review moving",
      },
    ],
  };
}

function commentaryItemHtml(item: PullRequestCommentaryItem): string {
  return `<p align="center">
  <strong>${escapeHtml(commentaryStyleLabel(item.style))}</strong><br>
  <em>${commentaryTextHtml(item.text)}</em>
</p>`;
}

function commentaryTextHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => escapeHtml(line.trim()))
    .filter((line) => line.length > 0)
    .join("<br>\n  ");
}

function commentaryStyleLabel(style: PullRequestCommentaryStyle): string {
  switch (style) {
    case "code_joke":
      return "Code joke";
    case "commit_fortune":
      return "Commit fortune";
    case "dry_release_note":
      return "Dry release note";
    case "haiku":
      return "Haiku";
    case "original_song_line":
      return "Original song line";
    case "sarcastic_summary":
      return "Sarcastic summary";
    case "tiny_changelog":
      return "Tiny changelog";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
