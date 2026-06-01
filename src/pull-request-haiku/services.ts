import type { Env } from "../env.ts";
import type { GitHubApiDependencies } from "../github/http.ts";
import {
  createIssueComment,
  createPullRequestHaikuInstallationToken,
  type GitHubIssueComment,
  type GitHubPullRequestChangedFile,
  type GitHubPullRequestDetails,
  getPullRequestDetails,
  listIssueComments,
  listPullRequestChangedFiles,
  updateIssueComment,
} from "../github/pull-request.ts";
import {
  getPullRequestHaikuCommentState,
  markPullRequestHaikuRunFailed,
  markPullRequestHaikuRunSkipped,
  markPullRequestHaikuRunStarted,
  markPullRequestHaikuRunSucceeded,
} from "../storage/pull-request-haiku.ts";
import type {
  PullRequestCommentaryStyle,
  PullRequestCommentaryItem,
  PullRequestHaiku,
  PullRequestHaikuGenerationMetadata,
} from "./comment.ts";
import type { PullRequestHaikuInput } from "./input.ts";

export type PullRequestHaikuTextModel = string;

export interface PullRequestHaikuTextResult {
  generationMetadata?: PullRequestHaikuGenerationMetadata;
  haiku: PullRequestHaiku;
  model: PullRequestHaikuTextModel | null;
}

export type { PullRequestCommentaryItem, PullRequestCommentaryStyle };

export interface PullRequestHaikuDependencies extends GitHubApiDependencies {
  generatePullRequestHaiku?(
    this: void,
    env: Env,
    input: PullRequestHaikuInput,
  ): Promise<PullRequestHaikuTextResult>;
  github?: PullRequestHaikuGitHubClient;
  now(): Date;
  store?: PullRequestHaikuStore;
}

export interface PullRequestHaikuGitHubClient {
  createInstallationToken(
    env: Env,
    installationId: number,
    repositoryId: number,
  ): Promise<{ token: string }>;
  createIssueComment(
    env: Env,
    input: {
      body: string;
      installationToken: string;
      pullRequestNumber: number;
      repositoryFullName: string;
    },
  ): Promise<GitHubIssueComment>;
  getPullRequestDetails(
    env: Env,
    input: {
      installationToken: string;
      pullRequestNumber: number;
      repositoryFullName: string;
    },
  ): Promise<GitHubPullRequestDetails>;
  listIssueComments(
    env: Env,
    input: {
      installationToken: string;
      pullRequestNumber: number;
      repositoryFullName: string;
    },
  ): Promise<GitHubIssueComment[]>;
  listPullRequestChangedFiles(
    env: Env,
    input: {
      installationToken: string;
      pullRequestNumber: number;
      repositoryFullName: string;
    },
  ): Promise<GitHubPullRequestChangedFile[]>;
  updateIssueComment(
    env: Env,
    input: {
      body: string;
      commentId: number;
      installationToken: string;
      repositoryFullName: string;
    },
  ): Promise<GitHubIssueComment>;
}

export interface PullRequestHaikuStore {
  getCommentState(
    env: Env,
    input: {
      pullRequestNumber: number;
      repositoryId: number;
    },
  ): Promise<Awaited<ReturnType<typeof getPullRequestHaikuCommentState>>>;
  markRunFailed(
    env: Env,
    input: { deliveryId: string; errorCode: string; errorMessage: string; failedAt: string },
  ): Promise<void>;
  markRunSkipped(
    env: Env,
    input: { deliveryId: string; errorCode: "stale_head_sha"; finishedAt: string },
  ): Promise<void>;
  markRunStarted(env: Env, input: { deliveryId: string; startedAt: string }): Promise<void>;
  markRunSucceeded(
    env: Env,
    input: {
      aiModel: string | null;
      commentId: number;
      deliveryId: string;
      finishedAt: string;
      headSha: string;
      outputKind: "markdown";
      pullRequestNumber: number;
      repositoryId: number;
    },
  ): Promise<void>;
}

export interface PullRequestHaikuServices {
  fetch: typeof fetch;
  generatePullRequestHaiku?(
    this: void,
    env: Env,
    input: PullRequestHaikuInput,
  ): Promise<PullRequestHaikuTextResult>;
  github: PullRequestHaikuGitHubClient;
  store: PullRequestHaikuStore;
}

export function pullRequestHaikuServices(
  dependencies: PullRequestHaikuDependencies,
): PullRequestHaikuServices {
  return {
    fetch: dependencies.fetch,
    generatePullRequestHaiku: dependencies.generatePullRequestHaiku,
    github: dependencies.github ?? defaultPullRequestHaikuGitHubClient(dependencies),
    store: dependencies.store ?? defaultPullRequestHaikuStore,
  };
}

function defaultPullRequestHaikuGitHubClient(
  dependencies: GitHubApiDependencies,
): PullRequestHaikuGitHubClient {
  return {
    createInstallationToken: (env, installationId, repositoryId) =>
      createPullRequestHaikuInstallationToken(
        env,
        installationId,
        String(repositoryId),
        dependencies,
      ),
    createIssueComment: (env, input) =>
      createIssueComment(
        env,
        input.repositoryFullName,
        input.pullRequestNumber,
        input.body,
        input.installationToken,
        dependencies,
      ),
    getPullRequestDetails: (env, input) =>
      getPullRequestDetails(
        env,
        input.repositoryFullName,
        input.pullRequestNumber,
        input.installationToken,
        dependencies,
      ),
    listIssueComments: (env, input) =>
      listIssueComments(
        env,
        input.repositoryFullName,
        input.pullRequestNumber,
        input.installationToken,
        dependencies,
      ),
    listPullRequestChangedFiles: (env, input) =>
      listPullRequestChangedFiles(
        env,
        input.repositoryFullName,
        input.pullRequestNumber,
        input.installationToken,
        dependencies,
      ),
    updateIssueComment: (env, input) =>
      updateIssueComment(
        env,
        input.repositoryFullName,
        input.commentId,
        input.body,
        input.installationToken,
        dependencies,
      ),
  };
}

const defaultPullRequestHaikuStore: PullRequestHaikuStore = {
  getCommentState: getPullRequestHaikuCommentState,
  markRunFailed: markPullRequestHaikuRunFailed,
  markRunSkipped: markPullRequestHaikuRunSkipped,
  markRunStarted: markPullRequestHaikuRunStarted,
  markRunSucceeded: markPullRequestHaikuRunSucceeded,
};
