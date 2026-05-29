import type {
  GitHubPullRequestChangedFile,
  GitHubPullRequestDetails,
} from "../github/pull-request.ts";

export interface PullRequestFacts {
  changed_files: number;
  files: Array<{
    additions: number;
    deletions: number;
    filename: string;
    status: string;
  }>;
  stats: {
    additions: number;
    deletions: number;
  };
}

export interface PullRequestSummary {
  change_shape: "balanced" | "mostly_addition" | "mostly_deletion";
  dominant_area: string;
  file_groups: Array<{
    additions: number;
    area: string;
    deletions: number;
    files: number;
  }>;
  notable_statuses: string[];
}

export type PullRequestHaikuInput =
  | {
      facts: PullRequestFacts;
      kind: "facts_only";
      summary: PullRequestSummary;
    }
  | {
      diff: string;
      facts: PullRequestFacts;
      kind: "diff_full";
      summary: PullRequestSummary;
    }
  | {
      diff: string;
      facts: PullRequestFacts;
      kind: "diff_truncated";
      omitted_files: number;
      summary: PullRequestSummary;
    };

const defaultMaxModelInputTokens = 6000;

export function buildPullRequestHaikuInput(input: {
  files: GitHubPullRequestChangedFile[];
  maxModelInputTokens?: number;
  pullRequest: GitHubPullRequestDetails;
}): PullRequestHaikuInput {
  const facts = pullRequestFacts(input.pullRequest, input.files);
  const summary = pullRequestSummary(input.files, input.pullRequest);

  const diffSections = rankedChangedFiles(input.files).flatMap((file) => {
    if (file.patch === null || file.patch.trim().length === 0) {
      return [];
    }

    return [diffSection(file)];
  });

  if (diffSections.length === 0) {
    return { facts, kind: "facts_only", summary };
  }

  const maxModelInputTokens = input.maxModelInputTokens ?? defaultMaxModelInputTokens;
  const includedSections: string[] = [];
  let omittedFiles = 0;

  for (const section of diffSections) {
    const candidateSections = [...includedSections, section];
    const candidateInput = diffInputForSections(
      facts,
      summary,
      candidateSections,
      diffSections.length,
    );

    if (estimatedTokens(JSON.stringify(candidateInput)) > maxModelInputTokens) {
      omittedFiles += 1;
      continue;
    }

    includedSections.push(section);
  }

  if (includedSections.length === 0) {
    return { facts, kind: "facts_only", summary };
  }

  if (omittedFiles === 0) {
    return {
      diff: includedSections.join("\n"),
      facts,
      kind: "diff_full",
      summary,
    };
  }

  return {
    diff: includedSections.join("\n"),
    facts,
    kind: "diff_truncated",
    omitted_files: omittedFiles,
    summary,
  };
}

function diffInputForSections(
  facts: PullRequestFacts,
  summary: PullRequestSummary,
  sections: string[],
  sectionCount: number,
): PullRequestHaikuInput {
  const diff = sections.join("\n");
  const omittedFiles = sectionCount - sections.length;

  return omittedFiles === 0
    ? { diff, facts, kind: "diff_full", summary }
    : { diff, facts, kind: "diff_truncated", omitted_files: omittedFiles, summary };
}

function diffSection(file: GitHubPullRequestChangedFile): string {
  return [
    `diff --git a/${file.filename} b/${file.filename}`,
    `--- a/${file.filename}`,
    `+++ b/${file.filename}`,
    file.patch ?? "",
  ].join("\n");
}

function pullRequestFacts(
  pullRequest: GitHubPullRequestDetails,
  files: GitHubPullRequestChangedFile[],
): PullRequestFacts {
  return {
    changed_files: pullRequest.changedFiles,
    files: files.slice(0, 80).map((file) => ({
      additions: file.additions,
      deletions: file.deletions,
      filename: file.filename,
      status: file.status,
    })),
    stats: {
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
    },
  };
}

function pullRequestSummary(
  files: GitHubPullRequestChangedFile[],
  pullRequest: GitHubPullRequestDetails,
): PullRequestSummary {
  const groups = new Map<string, { additions: number; deletions: number; files: number }>();
  const statuses = new Set<string>();

  for (const file of files) {
    const area = fileArea(file.filename);
    const current = groups.get(area) ?? { additions: 0, deletions: 0, files: 0 };
    groups.set(area, {
      additions: current.additions + file.additions,
      deletions: current.deletions + file.deletions,
      files: current.files + 1,
    });
    statuses.add(file.status);
  }

  const fileGroups = [...groups.entries()]
    .map(([area, group]) => ({ area, ...group }))
    .sort(
      (left, right) =>
        changeWeight(right) - changeWeight(left) || left.area.localeCompare(right.area),
    )
    .slice(0, 8);

  return {
    change_shape: changeShape(pullRequest),
    dominant_area: fileGroups[0]?.area ?? "repository",
    file_groups: fileGroups,
    notable_statuses: [...statuses].sort(),
  };
}

function rankedChangedFiles(files: GitHubPullRequestChangedFile[]): GitHubPullRequestChangedFile[] {
  return [...files].sort((left, right) => {
    const leftScore = fileSignalScore(left);
    const rightScore = fileSignalScore(right);

    return rightScore - leftScore || left.filename.localeCompare(right.filename);
  });
}

function fileSignalScore(file: GitHubPullRequestChangedFile): number {
  const changeCount = file.additions + file.deletions;
  const sizePenalty = Math.max(0, changeCount - 300) / 30;
  const generatedPenalty = isLowSignalPath(file.filename) ? 80 : 0;
  const patchBonus = file.patch === null || file.patch.trim().length === 0 ? 0 : 25;
  const testBonus = isTestPath(file.filename) ? 10 : 0;
  const sourceBonus = isSourcePath(file.filename) ? 15 : 0;
  const configBonus = isConfigPath(file.filename) ? 8 : 0;

  return (
    patchBonus +
    testBonus +
    sourceBonus +
    configBonus +
    Math.min(changeCount, 120) / 8 -
    sizePenalty -
    generatedPenalty
  );
}

function fileArea(filename: string): string {
  const parts = filename.split("/");

  if (parts.length >= 2 && (parts[0] === "src" || parts[0] === "test" || parts[0] === "docs")) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0] ?? "repository";
}

function changeShape(pullRequest: GitHubPullRequestDetails): PullRequestSummary["change_shape"] {
  if (pullRequest.additions > pullRequest.deletions * 2) {
    return "mostly_addition";
  }

  if (pullRequest.deletions > pullRequest.additions * 2) {
    return "mostly_deletion";
  }

  return "balanced";
}

function changeWeight(group: { additions: number; deletions: number }): number {
  return group.additions + group.deletions;
}

function isLowSignalPath(filename: string): boolean {
  return (
    filename.endsWith("pnpm-lock.yaml") ||
    filename.endsWith("package-lock.json") ||
    filename.endsWith("yarn.lock") ||
    filename.includes("/generated/") ||
    filename.includes("/__snapshots__/") ||
    filename.endsWith(".snap") ||
    filename.endsWith(".min.js")
  );
}

function isTestPath(filename: string): boolean {
  return filename.startsWith("test/") || filename.includes(".test.") || filename.includes(".spec.");
}

function isSourcePath(filename: string): boolean {
  return filename.startsWith("src/");
}

function isConfigPath(filename: string): boolean {
  return (
    filename.endsWith(".json") ||
    filename.endsWith(".jsonc") ||
    filename.endsWith(".yml") ||
    filename.endsWith(".yaml")
  );
}

function estimatedTokens(value: string): number {
  return Math.ceil(value.length / 3);
}
