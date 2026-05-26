import type { Env } from "../env.ts";
import {
  createIssueComment,
  createPullRequestHaikuInstallationToken,
  getPullRequestDetails,
  listIssueComments,
  listPullRequestChangedFiles,
  updateIssueComment,
  type GitHubPullRequestChangedFile,
  type GitHubPullRequestDetails,
} from "../github/pull-request.ts";
import { GitHubApiError, type GitHubApiDependencies } from "../github/http.ts";
import {
  getPullRequestHaikuCommentState,
  markPullRequestHaikuRunFailed,
  markPullRequestHaikuRunSkipped,
  markPullRequestHaikuRunStarted,
  markPullRequestHaikuRunSucceeded,
} from "../storage/pull-request-haiku.ts";
import {
  fallbackPullRequestHaiku,
  pullRequestHaikuCommentMarker,
  type PullRequestHaiku,
  renderPullRequestHaikuComment,
} from "./comment.ts";
import type { PullRequestHaikuQueueMessage } from "./queue.ts";

type PullRequestHaikuTextModel = "@cf/meta/llama-3.2-3b-instruct" | "@cf/qwen/qwen3-30b-a3b-fp8";

interface PullRequestHaikuTextResult {
  haiku: PullRequestHaiku;
  model: PullRequestHaikuTextModel | null;
}

const defaultTextModel: PullRequestHaikuTextModel = "@cf/qwen/qwen3-30b-a3b-fp8";

export interface PullRequestHaikuDependencies extends GitHubApiDependencies {
  now(): Date;
  generatePullRequestHaiku?(
    env: Env,
    pullRequest: GitHubPullRequestDetails,
    files: GitHubPullRequestChangedFile[],
  ): Promise<PullRequestHaikuTextResult>;
}

export async function processPullRequestHaikuMessage(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  dependencies: PullRequestHaikuDependencies,
): Promise<void> {
  const startedAt = dependencies.now().toISOString();
  await markPullRequestHaikuRunStarted(env, {
    deliveryId: message.deliveryId,
    startedAt,
  });

  try {
    const state = await getPullRequestHaikuCommentState(env, {
      pullRequestNumber: message.pullRequestNumber,
      repositoryId: message.repositoryId,
    });

    if (state !== null && state.currentHeadSha !== message.headSha) {
      await markPullRequestHaikuRunSkipped(env, {
        deliveryId: message.deliveryId,
        errorCode: "stale_head_sha",
        finishedAt: dependencies.now().toISOString(),
      });
      return;
    }

    const token = await createPullRequestHaikuInstallationToken(
      env,
      message.installationId,
      String(message.repositoryId),
      dependencies,
    );
    const pullRequest = await getPullRequestDetails(
      env,
      message.repositoryFullName,
      message.pullRequestNumber,
      token.token,
      dependencies,
    );
    const files = await listPullRequestChangedFiles(
      env,
      message.repositoryFullName,
      message.pullRequestNumber,
      token.token,
      dependencies,
    );
    const textResult =
      dependencies.generatePullRequestHaiku === undefined
        ? await generatePullRequestHaiku(env, pullRequest, files)
        : await dependencies.generatePullRequestHaiku(env, pullRequest, files);
    const body = renderPullRequestHaikuComment({
      haiku: textResult.haiku,
      pullRequest,
      repositoryId: message.repositoryId,
    });
    const commentId =
      state?.commentId ??
      (await findExistingPullRequestHaikuCommentId(env, message, token.token, dependencies));
    const comment = await upsertPullRequestHaikuComment(
      env,
      message,
      body,
      commentId,
      token.token,
      dependencies,
    );

    await markPullRequestHaikuRunSucceeded(env, {
      aiModel: textResult.model,
      commentId: comment.id,
      deliveryId: message.deliveryId,
      finishedAt: dependencies.now().toISOString(),
      headSha: pullRequest.headSha,
      outputKind: "markdown",
      pullRequestNumber: message.pullRequestNumber,
      repositoryId: message.repositoryId,
    });
  } catch (error) {
    await markPullRequestHaikuRunFailed(env, {
      deliveryId: message.deliveryId,
      errorCode: "processing_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: dependencies.now().toISOString(),
    });
    throw error;
  }
}

async function generatePullRequestHaiku(
  env: Env,
  pullRequest: GitHubPullRequestDetails,
  files: GitHubPullRequestChangedFile[],
): Promise<PullRequestHaikuTextResult> {
  const fallback = fallbackPullRequestHaiku();
  const fallbackResult = {
    haiku: fallback,
    model: null,
  } satisfies PullRequestHaikuTextResult;

  if (env.AI === undefined) {
    return fallbackResult;
  }

  const model = textModelForEnv(env);

  try {
    const result = await runTextGeneration(env, model, {
      max_tokens: 180,
      messages: [
        {
          content: `You write one short haiku for a GitHub pull request from mechanical changed-file facts only.
Be inventive, but stay grounded in the provided facts and do not claim to have read patches.
The facts intentionally exclude human-authored pull request text such as titles, descriptions, branch names, and commit messages.
Do not spend tokens on reasoning. Return the haiku directly. /no_think

Return only the haiku: three short lines separated by newline characters.
The haiku should represent the change, its scale, and its likely area of the codebase.
Prefer haiku-like imagery over strict syllable counting. Do not include a title, label, explanation, markdown fence, or any mention that you are an AI model.`,
          role: "system",
        },
        {
          content: `/no_think\n${JSON.stringify(pullRequestFacts(pullRequest, files))}`,
          role: "user",
        },
      ],
      temperature: 0.85,
      top_p: 0.9,
    });

    const response = textGenerationResponsePayload(result);

    if (response === null) {
      console.error("pull_request_haiku_text_generation_unrecognized_response", {
        pull_request: pullRequest.number,
        response_shape: responseShape(result),
      });
      return fallbackResult;
    }

    return {
      haiku: { text: haikuString(response, fallback.text) },
      model,
    };
  } catch (error) {
    console.error("pull_request_haiku_generation_failed", {
      message: error instanceof Error ? error.message : String(error),
      pull_request: pullRequest.number,
    });
    return fallbackResult;
  }
}

function textModelForEnv(env: Env): PullRequestHaikuTextModel {
  return env.PULL_REQUEST_HAIKU_TEXT_MODEL === "@cf/meta/llama-3.2-3b-instruct" ||
    env.PULL_REQUEST_HAIKU_TEXT_MODEL === "@cf/qwen/qwen3-30b-a3b-fp8"
    ? env.PULL_REQUEST_HAIKU_TEXT_MODEL
    : defaultTextModel;
}

function runTextGeneration(
  env: Env,
  model: PullRequestHaikuTextModel,
  input: AiTextGenerationInput,
) {
  if (env.AI === undefined) {
    throw new Error("Workers AI binding is unavailable");
  }

  switch (model) {
    case "@cf/meta/llama-3.2-3b-instruct":
      return env.AI.run("@cf/meta/llama-3.2-3b-instruct", input);
    case "@cf/qwen/qwen3-30b-a3b-fp8":
      return env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", input);
  }
}

function textGenerationResponsePayload(result: unknown): string | null {
  if (typeof result === "string") {
    return result;
  }

  if (!isRecord(result)) {
    return null;
  }

  const response = result["response"];

  if (typeof response === "string") {
    return response;
  }

  const choices = choicesList(result["choices"]);

  if (choices === null) {
    return null;
  }

  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }

    const content = choiceContent(choice);

    if (content !== null) {
      return content;
    }
  }

  return null;
}

function choicesList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  return isRecord(value) ? Object.values(value) : null;
}

function choiceContent(choice: Record<string, unknown>): string | null {
  for (const key of ["text", "content", "output_text", "generated_text"]) {
    const content = textFromContentValue(choice[key]);

    if (content !== null) {
      return content;
    }
  }

  for (const key of ["message", "delta"]) {
    const value = choice[key];

    if (!isRecord(value)) {
      continue;
    }

    const content = value["content"];

    const text = textFromContentValue(content);

    if (text !== null) {
      return text;
    }

    if (typeof content === "string" && content.length > 0) {
      return content;
    }
  }

  return null;
}

function textFromContentValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => textFromContentValue(part))
      .filter((part): part is string => part !== null);

    return parts.length === 0 ? null : parts.join("\n");
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["text", "content", "output_text", "generated_text"]) {
    const content = textFromContentValue(value[key]);

    if (content !== null) {
      return content;
    }
  }

  return null;
}

function responseShape(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return typeof result;
  }

  if (Array.isArray(result)) {
    return "array";
  }

  return Object.keys(result).sort().join(",");
}

function pullRequestFacts(
  pullRequest: GitHubPullRequestDetails,
  files: GitHubPullRequestChangedFile[],
) {
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

function haikuString(value: string, fallback: string): string {
  const lines = stripThinkingBlocks(value)
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return fallback;
  }

  return truncate(lines.slice(0, 3).join("\n"), 240);
}

function stripThinkingBlocks(value: string): string {
  return value.replaceAll(/<think>[\s\S]*?<\/think>/giu, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

async function upsertPullRequestHaikuComment(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  body: string,
  commentId: number | null,
  installationToken: string,
  dependencies: GitHubApiDependencies,
) {
  if (commentId === null) {
    return createIssueComment(
      env,
      message.repositoryFullName,
      message.pullRequestNumber,
      body,
      installationToken,
      dependencies,
    );
  }

  try {
    return await updateIssueComment(
      env,
      message.repositoryFullName,
      commentId,
      body,
      installationToken,
      dependencies,
    );
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }

  const fallbackCommentId = await findExistingPullRequestHaikuCommentId(
    env,
    message,
    installationToken,
    dependencies,
  );

  if (fallbackCommentId !== null && fallbackCommentId !== commentId) {
    return updateIssueComment(
      env,
      message.repositoryFullName,
      fallbackCommentId,
      body,
      installationToken,
      dependencies,
    );
  }

  return createIssueComment(
    env,
    message.repositoryFullName,
    message.pullRequestNumber,
    body,
    installationToken,
    dependencies,
  );
}

async function findExistingPullRequestHaikuCommentId(
  env: Env,
  message: PullRequestHaikuQueueMessage,
  installationToken: string,
  dependencies: GitHubApiDependencies,
): Promise<number | null> {
  const marker = pullRequestHaikuCommentMarker({
    pullRequestNumber: message.pullRequestNumber,
    repositoryId: message.repositoryId,
  });
  const comments = await listIssueComments(
    env,
    message.repositoryFullName,
    message.pullRequestNumber,
    installationToken,
    dependencies,
  );

  return comments.find((comment) => comment.body.includes(marker))?.id ?? null;
}
