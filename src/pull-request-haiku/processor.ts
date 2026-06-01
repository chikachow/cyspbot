import type { Env } from "../env.ts";
import { GitHubApiError } from "../github/http.ts";
import { pullRequestHaikuCommentMarker, renderPullRequestHaikuComment } from "./comment.ts";
import {
  generatePullRequestHaiku,
  normalizedCommentary,
  normalizedHaikuString,
} from "./generation.ts";
import { buildPullRequestHaikuInput } from "./input.ts";
import type { PullRequestHaikuQueueMessage } from "./queue.ts";
import {
  pullRequestHaikuServices,
  type PullRequestHaikuDependencies,
  type PullRequestHaikuGitHubClient,
  type PullRequestHaikuServices,
  type PullRequestHaikuTextResult,
} from "./services.ts";

export { normalizedCommentary, normalizedHaikuString };

export type {
  PullRequestHaikuDependencies,
  PullRequestHaikuGitHubClient,
  PullRequestHaikuStore,
  PullRequestHaikuTextResult,
} from "./services.ts";

type PullRequestHaikuRunOutcome =
  | {
      errorCode: "stale_head_sha";
      kind: "skipped";
    }
  | {
      aiModel: PullRequestHaikuTextResult["model"];
      commentId: number;
      headSha: string;
      kind: "succeeded";
    };

export async function processPullRequestHaikuMessage(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  dependencies: PullRequestHaikuDependencies,
): Promise<void> {
  const services = pullRequestHaikuServices(dependencies);
  const startedAt = dependencies.now().toISOString();
  await services.store.markRunStarted(env, {
    deliveryId: message.deliveryId,
    startedAt,
  });

  try {
    const outcome = await executePullRequestHaikuRun(env, message, services);
    await finalizePullRequestHaikuRun(
      env,
      message,
      outcome,
      dependencies.now().toISOString(),
      services,
    );
  } catch (error) {
    await services.store.markRunFailed(env, {
      deliveryId: message.deliveryId,
      errorCode: "processing_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: dependencies.now().toISOString(),
    });
    throw error;
  }
}

async function executePullRequestHaikuRun(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  services: PullRequestHaikuServices,
): Promise<PullRequestHaikuRunOutcome> {
  const state = await services.store.getCommentState(env, {
    pullRequestNumber: message.pullRequestNumber,
    repositoryId: message.repositoryId,
  });

  if (state !== null && state.currentHeadSha !== message.headSha) {
    return { errorCode: "stale_head_sha", kind: "skipped" };
  }

  const token = await services.github.createInstallationToken(
    env,
    message.installationId,
    message.repositoryId,
  );
  const [pullRequest, files] = await Promise.all([
    services.github.getPullRequestDetails(env, {
      installationToken: token.token,
      pullRequestNumber: message.pullRequestNumber,
      repositoryFullName: message.repositoryFullName,
    }),
    services.github.listPullRequestChangedFiles(env, {
      installationToken: token.token,
      pullRequestNumber: message.pullRequestNumber,
      repositoryFullName: message.repositoryFullName,
    }),
  ]);
  const input = buildPullRequestHaikuInput({
    files,
    pullRequest,
  });
  const textResult =
    services.generatePullRequestHaiku === undefined
      ? await generatePullRequestHaiku(env, input, services.fetch)
      : await services.generatePullRequestHaiku(env, input);
  const body = renderPullRequestHaikuComment({
    generationMetadata: textResult.generationMetadata,
    haiku: textResult.haiku,
    pullRequest,
    repositoryId: message.repositoryId,
  });
  const commentId =
    state?.commentId ??
    (await findExistingPullRequestHaikuCommentId(env, message, token.token, services.github));
  const comment = await upsertPullRequestHaikuComment(
    env,
    message,
    body,
    commentId,
    token.token,
    services.github,
  );

  return {
    aiModel: textResult.model,
    commentId: comment.id,
    headSha: pullRequest.headSha,
    kind: "succeeded",
  };
}

function finalizePullRequestHaikuRun(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  outcome: PullRequestHaikuRunOutcome,
  finishedAt: string,
  services: PullRequestHaikuServices,
): Promise<void> {
  switch (outcome.kind) {
    case "skipped":
      return services.store.markRunSkipped(env, {
        deliveryId: message.deliveryId,
        errorCode: outcome.errorCode,
        finishedAt,
      });
    case "succeeded":
      return services.store.markRunSucceeded(env, {
        aiModel: outcome.aiModel,
        commentId: outcome.commentId,
        deliveryId: message.deliveryId,
        finishedAt,
        headSha: outcome.headSha,
        outputKind: "markdown",
        pullRequestNumber: message.pullRequestNumber,
        repositoryId: message.repositoryId,
      });
  }
}

async function upsertPullRequestHaikuComment(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  body: string,
  commentId: number | null,
  installationToken: string,
  github: PullRequestHaikuGitHubClient,
) {
  if (commentId === null) {
    return github.createIssueComment(env, {
      body,
      installationToken,
      pullRequestNumber: message.pullRequestNumber,
      repositoryFullName: message.repositoryFullName,
    });
  }

  try {
    return await github.updateIssueComment(env, {
      body,
      commentId,
      installationToken,
      repositoryFullName: message.repositoryFullName,
    });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }

  const fallbackCommentId = await findExistingPullRequestHaikuCommentId(
    env,
    message,
    installationToken,
    github,
  );

  if (fallbackCommentId !== null && fallbackCommentId !== commentId) {
    return github.updateIssueComment(env, {
      body,
      commentId: fallbackCommentId,
      installationToken,
      repositoryFullName: message.repositoryFullName,
    });
  }

  return github.createIssueComment(env, {
    body,
    installationToken,
    pullRequestNumber: message.pullRequestNumber,
    repositoryFullName: message.repositoryFullName,
  });
}

async function findExistingPullRequestHaikuCommentId(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  installationToken: string,
  github: PullRequestHaikuGitHubClient,
): Promise<number | null> {
  const marker = pullRequestHaikuCommentMarker({
    pullRequestNumber: message.pullRequestNumber,
    repositoryId: message.repositoryId,
  });
  const comments = await github.listIssueComments(env, {
    installationToken,
    pullRequestNumber: message.pullRequestNumber,
    repositoryFullName: message.repositoryFullName,
  });

  return comments.find((comment) => comment.body.includes(marker))?.id ?? null;
}
