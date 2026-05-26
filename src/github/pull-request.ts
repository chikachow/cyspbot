import type { Env } from "../env.ts";
import {
  createInstallationToken,
  installationAuthenticationHeaders,
  type InstallationToken,
} from "./app.ts";
import {
  defaultGitHubApiDependencies,
  fetchGitHubApi,
  GitHubApiError,
  type GitHubApiDependencies,
} from "./http.ts";

export interface GitHubPullRequestDetails {
  additions: number;
  baseRef: string;
  body: string | null;
  changedFiles: number;
  deletions: number;
  draft: boolean;
  headRef: string;
  headSha: string;
  htmlUrl: string;
  number: number;
  title: string;
  userLogin: string;
}

export interface GitHubPullRequestChangedFile {
  additions: number;
  changes: number;
  deletions: number;
  filename: string;
  status: string;
}

export interface GitHubIssueComment {
  body: string;
  id: number;
}

interface GitHubPullRequestApiResponse {
  additions?: unknown;
  base?: {
    ref?: unknown;
  };
  body?: unknown;
  changed_files?: unknown;
  deletions?: unknown;
  draft?: unknown;
  head?: {
    ref?: unknown;
    sha?: unknown;
  };
  html_url?: unknown;
  number?: unknown;
  title?: unknown;
  user?: {
    login?: unknown;
  };
}

interface GitHubPullRequestChangedFileApiResponse {
  additions?: unknown;
  changes?: unknown;
  deletions?: unknown;
  filename?: unknown;
  status?: unknown;
}

interface GitHubIssueCommentApiResponse {
  body?: unknown;
  id?: unknown;
}

export function createPullRequestHaikuInstallationToken(
  env: Env,
  installationId: number,
  repositoryId: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<InstallationToken> {
  return createInstallationToken(
    env,
    installationId,
    repositoryId,
    { issues: "write", metadata: "read", pull_requests: "write" },
    dependencies,
  );
}

export async function getPullRequestDetails(
  env: Env,
  repository: string,
  pullRequestNumber: number,
  installationToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubPullRequestDetails> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}/pulls/${pullRequestNumber}`,
    installationAuthenticationHeaders(installationToken),
    dependencies,
  );
  const body = (await response.json()) as GitHubPullRequestApiResponse;

  if (
    typeof body.number !== "number" ||
    typeof body.title !== "string" ||
    (body.body !== null && body.body !== undefined && typeof body.body !== "string") ||
    typeof body.html_url !== "string" ||
    typeof body.user?.login !== "string" ||
    typeof body.head?.sha !== "string" ||
    typeof body.head.ref !== "string" ||
    typeof body.base?.ref !== "string" ||
    typeof body.draft !== "boolean" ||
    typeof body.additions !== "number" ||
    typeof body.deletions !== "number" ||
    typeof body.changed_files !== "number"
  ) {
    throw new GitHubApiError(502, "invalid pull request response");
  }

  return {
    additions: body.additions,
    baseRef: body.base.ref,
    body: body.body ?? null,
    changedFiles: body.changed_files,
    deletions: body.deletions,
    draft: body.draft,
    headRef: body.head.ref,
    headSha: body.head.sha,
    htmlUrl: body.html_url,
    number: body.number,
    title: body.title,
    userLogin: body.user.login,
  };
}

export async function listPullRequestChangedFiles(
  env: Env,
  repository: string,
  pullRequestNumber: number,
  installationToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubPullRequestChangedFile[]> {
  const files: GitHubPullRequestChangedFile[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetchGitHubApi(
      env,
      `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
      installationAuthenticationHeaders(installationToken),
      dependencies,
    );
    const body = (await response.json()) as GitHubPullRequestChangedFileApiResponse[];

    if (!Array.isArray(body)) {
      throw new GitHubApiError(502, "invalid pull request files response");
    }

    for (const file of body) {
      if (
        typeof file.filename !== "string" ||
        typeof file.status !== "string" ||
        typeof file.additions !== "number" ||
        typeof file.deletions !== "number" ||
        typeof file.changes !== "number"
      ) {
        throw new GitHubApiError(502, "invalid pull request file response");
      }

      files.push({
        additions: file.additions,
        changes: file.changes,
        deletions: file.deletions,
        filename: file.filename,
        status: file.status,
      });
    }

    if (body.length < 100) {
      return files;
    }
  }
}

export async function listIssueComments(
  env: Env,
  repository: string,
  issueNumber: number,
  installationToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubIssueComment[]> {
  const comments: GitHubIssueComment[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetchGitHubApi(
      env,
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      installationAuthenticationHeaders(installationToken),
      dependencies,
    );
    const body = (await response.json()) as GitHubIssueCommentApiResponse[];

    if (!Array.isArray(body)) {
      throw new GitHubApiError(502, "invalid issue comments response");
    }

    for (const comment of body) {
      comments.push(parseIssueCommentResponse(comment));
    }

    if (body.length < 100) {
      return comments;
    }
  }
}

export async function createIssueComment(
  env: Env,
  repository: string,
  issueNumber: number,
  body: string,
  installationToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubIssueComment> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}/issues/${issueNumber}/comments`,
    installationAuthenticationHeaders(installationToken),
    dependencies,
    {
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return parseIssueCommentResponse(await response.json());
}

export async function updateIssueComment(
  env: Env,
  repository: string,
  commentId: number,
  body: string,
  installationToken: string,
  dependencies: GitHubApiDependencies = defaultGitHubApiDependencies,
): Promise<GitHubIssueComment> {
  const response = await fetchGitHubApi(
    env,
    `/repos/${repository}/issues/comments/${commentId}`,
    installationAuthenticationHeaders(installationToken),
    dependencies,
    {
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  return parseIssueCommentResponse(await response.json());
}

function parseIssueCommentResponse(body: unknown): GitHubIssueComment {
  const comment = body as GitHubIssueCommentApiResponse;

  if (typeof comment.id !== "number" || typeof comment.body !== "string") {
    throw new GitHubApiError(502, "invalid issue comment response");
  }

  return {
    body: comment.body,
    id: comment.id,
  };
}
