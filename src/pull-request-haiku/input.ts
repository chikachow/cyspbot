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

export type PullRequestHaikuInput =
  | {
      facts: PullRequestFacts;
      kind: "facts_only";
    }
  | {
      diff: string;
      facts: PullRequestFacts;
      kind: "diff_full";
    }
  | {
      diff: string;
      facts: PullRequestFacts;
      kind: "diff_truncated";
      omitted_files: number;
    };

const defaultMaxModelInputTokens = 6000;

export function buildPullRequestHaikuInput(input: {
  files: GitHubPullRequestChangedFile[];
  maxModelInputTokens?: number;
  pullRequest: GitHubPullRequestDetails;
}): PullRequestHaikuInput {
  const facts = pullRequestFacts(input.pullRequest, input.files);

  const diffSections = input.files.flatMap((file) => {
    if (file.patch === null || file.patch.trim().length === 0) {
      return [];
    }

    return [diffSection(file)];
  });

  if (diffSections.length === 0) {
    return { facts, kind: "facts_only" };
  }

  const maxModelInputTokens = input.maxModelInputTokens ?? defaultMaxModelInputTokens;
  const includedSections: string[] = [];
  let omittedFiles = 0;

  for (const section of diffSections) {
    const candidateSections = [...includedSections, section];
    const candidateInput = diffInputForSections(facts, candidateSections, diffSections.length);

    if (estimatedTokens(JSON.stringify(candidateInput)) > maxModelInputTokens) {
      omittedFiles += 1;
      continue;
    }

    includedSections.push(section);
  }

  if (includedSections.length === 0) {
    return { facts, kind: "facts_only" };
  }

  if (omittedFiles === 0) {
    return {
      diff: includedSections.join("\n"),
      facts,
      kind: "diff_full",
    };
  }

  return {
    diff: includedSections.join("\n"),
    facts,
    kind: "diff_truncated",
    omitted_files: omittedFiles,
  };
}

function diffInputForSections(
  facts: PullRequestFacts,
  sections: string[],
  sectionCount: number,
): PullRequestHaikuInput {
  const diff = sections.join("\n");
  const omittedFiles = sectionCount - sections.length;

  return omittedFiles === 0
    ? { diff, facts, kind: "diff_full" }
    : { diff, facts, kind: "diff_truncated", omitted_files: omittedFiles };
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

function estimatedTokens(value: string): number {
  return Math.ceil(value.length / 3);
}
