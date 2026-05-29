import type { Env } from "../env.ts";
import { GitHubApiError } from "../github/http.ts";
import {
  fallbackPullRequestHaiku,
  pullRequestHaikuCommentMarker,
  type PullRequestHaikuCostEstimate,
  renderPullRequestHaikuComment,
} from "./comment.ts";
import { buildPullRequestHaikuInput, type PullRequestHaikuInput } from "./input.ts";
import type { PullRequestHaikuQueueMessage } from "./queue.ts";
import {
  pullRequestHaikuServices,
  type PullRequestHaikuDependencies,
  type PullRequestHaikuGitHubClient,
  type PullRequestHaikuServices,
  type PullRequestHaikuTextModel,
  type PullRequestHaikuTextResult,
} from "./services.ts";

export type {
  PullRequestHaikuDependencies,
  PullRequestHaikuGitHubClient,
  PullRequestHaikuStore,
  PullRequestHaikuTextResult,
} from "./services.ts";

interface TextGenerationTokenUsage {
  cachedInputTokens: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number | null;
}

interface TextModelPricing {
  inputNeuronsPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  outputNeuronsPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

const defaultTextModel: PullRequestHaikuTextModel = "@cf/qwen/qwen3-30b-a3b-fp8";

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
      ? await generatePullRequestHaiku(env, input)
      : await services.generatePullRequestHaiku(env, input);
  const body = renderPullRequestHaikuComment({
    costEstimate: textResult.costEstimate,
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

async function generatePullRequestHaiku(
  env: Env,
  input: PullRequestHaikuInput,
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
      max_tokens: 100,
      messages: [
        {
          content: haikuSystemPrompt(input),
          role: "system",
        },
        {
          content: `/no_think\n${JSON.stringify(input)}`,
          role: "user",
        },
      ],
      temperature: 0.75,
      top_p: 0.9,
    });

    const response = textGenerationResponsePayload(result);

    if (response === null) {
      console.error("pull_request_haiku_text_generation_unrecognized_response", {
        input_kind: input.kind,
        response_shape: responseShape(result),
      });
      return fallbackResult;
    }

    return {
      costEstimate: costEstimateForTextGeneration(model, result),
      haiku: { text: normalizedHaikuString(response, fallback.text) },
      model,
    };
  } catch (error) {
    console.error("pull_request_haiku_generation_failed", {
      message: error instanceof Error ? error.message : String(error),
      input_kind: input.kind,
    });
    return fallbackResult;
  }
}

function haikuSystemPrompt(input: PullRequestHaikuInput): string {
  return `You write one short haiku for a GitHub pull request from code-related pull request facts.
Be inventive, but stay grounded in the provided code facts and diff context.
The facts intentionally exclude human-authored pull request text such as titles, descriptions, branch names, and commit messages.
${inputContextInstruction(input)}
Do not spend tokens on reasoning. Return the haiku directly. /no_think

Return only the haiku: three short lines separated by newline characters.
The haiku should represent the change, its scale, and its likely area of the codebase.
Prefer haiku-like imagery over strict syllable counting. Do not include a title, label, explanation, markdown fence, or any mention that you are an AI model.`;
}

function inputContextInstruction(input: PullRequestHaikuInput): string {
  switch (input.kind) {
    case "diff_full":
      return "The input includes all available bounded diff hunks selected for this pull request.";
    case "diff_truncated":
      return "The input includes selected bounded diff hunks, but some file hunks were omitted for size. Avoid claims that require omitted context.";
    case "facts_only":
      return "The input includes changed-file facts and a local summary only. Do not imply you inspected patch contents.";
  }
}

function textModelForEnv(env: Env): PullRequestHaikuTextModel {
  return env.PULL_REQUEST_HAIKU_TEXT_MODEL === "@cf/meta/llama-3.2-3b-instruct" ||
    env.PULL_REQUEST_HAIKU_TEXT_MODEL === "@cf/qwen/qwen3-30b-a3b-fp8"
    ? env.PULL_REQUEST_HAIKU_TEXT_MODEL
    : defaultTextModel;
}

function pricingForTextModel(model: PullRequestHaikuTextModel): TextModelPricing {
  switch (model) {
    case "@cf/meta/llama-3.2-3b-instruct":
    case "@cf/qwen/qwen3-30b-a3b-fp8":
      return {
        inputNeuronsPerMillionTokens: 4625,
        inputUsdPerMillionTokens: 0.051,
        outputNeuronsPerMillionTokens: 30475,
        outputUsdPerMillionTokens: 0.335,
      };
  }
}

function costEstimateForTextGeneration(
  model: PullRequestHaikuTextModel,
  result: unknown,
): PullRequestHaikuCostEstimate | undefined {
  const usage = textGenerationTokenUsage(result);

  if (usage === null) {
    return undefined;
  }

  const pricing = pricingForTextModel(model);
  const estimatedCostUsd =
    (usage.inputTokens * pricing.inputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000;
  const estimatedNeurons =
    (usage.inputTokens * pricing.inputNeuronsPerMillionTokens +
      usage.outputTokens * pricing.outputNeuronsPerMillionTokens) /
    1_000_000;

  return {
    cachedInputTokens: usage.cachedInputTokens,
    estimatedCostUsd: roundDecimal(estimatedCostUsd, 10),
    estimatedNeurons: roundDecimal(estimatedNeurons, 6),
    inputTokens: usage.inputTokens,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    model,
    outputTokens: usage.outputTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    scope: "prompt",
    totalTokens: usage.totalTokens,
  };
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

function textGenerationTokenUsage(result: unknown): TextGenerationTokenUsage | null {
  if (!isRecord(result)) {
    return null;
  }

  const usage = result["usage"];

  if (!isRecord(usage)) {
    return null;
  }

  const inputTokens = integerValue(usage["prompt_tokens"] ?? usage["input_tokens"]);
  const outputTokens = integerValue(usage["completion_tokens"] ?? usage["output_tokens"]);

  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  return {
    cachedInputTokens: cachedInputTokens(usage),
    inputTokens,
    outputTokens,
    totalTokens: integerValue(usage["total_tokens"]),
  };
}

function cachedInputTokens(usage: Record<string, unknown>): number | null {
  const direct = integerValue(usage["cached_tokens"] ?? usage["cached_input_tokens"]);

  if (direct !== null) {
    return direct;
  }

  for (const key of ["prompt_tokens_details", "input_tokens_details"]) {
    const details = usage[key];

    if (!isRecord(details)) {
      continue;
    }

    const cachedTokens = integerValue(details["cached_tokens"]);

    if (cachedTokens !== null) {
      return cachedTokens;
    }
  }

  return null;
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

export function normalizedHaikuString(value: string, fallback: string): string {
  const lines = stripThinkingBlocks(value)
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);

  if (lines.length !== 3 || lines.some((line) => !validHaikuLine(line))) {
    return fallback;
  }

  return lines.join("\n");
}

function stripThinkingBlocks(value: string): string {
  return value.replaceAll(/<think>[\s\S]*?<\/think>/giu, "").trim();
}

function validHaikuLine(line: string): boolean {
  return (
    line.length > 0 &&
    line.length <= 80 &&
    !/```/u.test(line) &&
    !/^\s*[-*]\s+/u.test(line) &&
    !/^\s*(haiku|title|poem)\s*:/iu.test(line) &&
    !/\b(ai|model|prompt|language model)\b/iu.test(line)
  );
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function roundDecimal(value: number, places: number): number {
  const multiplier = 10 ** places;

  return Math.round(value * multiplier) / multiplier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
