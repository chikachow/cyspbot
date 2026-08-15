const githubIssueCommentStatusReactionJobKind = "github.issue-comment.status-reaction" as const;
const githubIssueCommentStatusReactionJobVersion = 1 as const;

export interface GitHubIssueCommentStatusReactionJob {
  readonly kind: typeof githubIssueCommentStatusReactionJobKind;
  readonly version: typeof githubIssueCommentStatusReactionJobVersion;
  readonly deliveryId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
  };
  readonly commentId: number;
}

export function parseGitHubIssueCommentStatusReactionJob(
  value: unknown,
): GitHubIssueCommentStatusReactionJob | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, ["commentId", "deliveryId", "kind", "repository", "version"])
  ) {
    return undefined;
  }

  if (
    value["kind"] !== githubIssueCommentStatusReactionJobKind ||
    value["version"] !== githubIssueCommentStatusReactionJobVersion ||
    !isNonEmptyString(value["deliveryId"]) ||
    !isSafeIdentifier(value["commentId"])
  ) {
    return undefined;
  }

  const repository = value["repository"];
  if (
    !isRecord(repository) ||
    !hasKeys(repository, ["name", "owner"]) ||
    !isRepositoryPart(repository["owner"]) ||
    !isRepositoryPart(repository["name"])
  ) {
    return undefined;
  }

  return {
    commentId: value["commentId"],
    deliveryId: value["deliveryId"],
    kind: githubIssueCommentStatusReactionJobKind,
    repository: {
      name: repository["name"],
      owner: repository["owner"],
    },
    version: githubIssueCommentStatusReactionJobVersion,
  };
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = keys.slice().sort();

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRepositoryPart(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    value.includes("\\") ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return false;
    }
  }

  return true;
}

function isSafeIdentifier(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
