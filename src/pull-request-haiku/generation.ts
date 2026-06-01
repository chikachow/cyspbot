import type { Env } from "../env.ts";
import {
  fallbackPullRequestHaiku,
  type PullRequestCommentaryItem,
  type PullRequestHaiku,
  type PullRequestHaikuGenerationMetadata,
} from "./comment.ts";
import type { PullRequestHaikuInput } from "./input.ts";
import type {
  PullRequestCommentaryStyle,
  PullRequestHaikuTextModel,
  PullRequestHaikuTextResult,
} from "./services.ts";

interface TextGenerationTokenUsage {
  cachedInputTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

interface OpenRouterChatCompletionInput {
  max_tokens: number;
  messages: { content: string; role: "system" | "user" }[];
  model: string;
  response_format: { type: "json_object" };
  temperature: number;
  top_p: number;
}

const defaultTextModels = ["google/gemini-2.5-flash", "openai/gpt-5.4-mini"] as const;
const commentaryStyles = [
  "code_joke",
  "commit_fortune",
  "dry_release_note",
  "haiku",
  "original_song_line",
  "sarcastic_summary",
  "tiny_changelog",
] satisfies PullRequestCommentaryStyle[];

export async function generatePullRequestHaiku(
  env: Env,
  input: PullRequestHaikuInput,
  fetcher: typeof fetch,
): Promise<PullRequestHaikuTextResult> {
  const fallback = fallbackPullRequestHaiku();
  const fallbackResult = {
    haiku: fallback,
    model: null,
  } satisfies PullRequestHaikuTextResult;
  const endpoint = await openRouterGatewayChatCompletionsUrl(env);

  if (endpoint === null) {
    return fallbackResult;
  }

  const gatewayAuthorization = aiGatewayAuthorizationHeader(env);

  for (const model of textModelsForEnv(env)) {
    try {
      const result = await runTextGeneration(fetcher, endpoint, gatewayAuthorization, {
        max_tokens: 600,
        messages: [
          {
            content: commentarySystemPrompt(input),
            role: "system",
          },
          {
            content: `/no_think\n${JSON.stringify(input)}`,
            role: "user",
          },
        ],
        model,
        response_format: { type: "json_object" },
        temperature: 0.75,
        top_p: 0.9,
      });

      const response = textGenerationResponsePayload(result);

      if (response === null) {
        console.error("pull_request_haiku_text_generation_unrecognized_response", {
          input_kind: input.kind,
          model,
          response_shape: responseShape(result),
        });
        continue;
      }

      return {
        generationMetadata: generationMetadataForTextGeneration(model, result),
        haiku: normalizedCommentary(response, fallback),
        model,
      };
    } catch (error) {
      console.error("pull_request_haiku_generation_failed", {
        input_kind: input.kind,
        message: error instanceof Error ? error.message : String(error),
        model,
      });
    }
  }

  return fallbackResult;
}

function commentarySystemPrompt(input: PullRequestHaikuInput): string {
  return `You write short pull request commentary from code-related pull request facts.
Generate exactly one item for every style in this enum: ${commentaryStyles.join(", ")}.
Keep every item grounded in the provided code facts and diff context.
Make the seven items meaningfully different from each other: vary the angle, imagery, and wording.
Prefer concrete cues from filenames, dominant area, change shape, tests, config, storage, or docs over generic words like "code", "change", "diff", or "review".
The facts intentionally exclude human-authored pull request text such as titles, descriptions, branch names, and commit messages.
${inputContextInstruction(input)}
Do not spend tokens on reasoning. Return the JSON object directly. /no_think

Return only compact JSON with this exact shape: {"items":[{"style":"<one enum value>","text":"<commentary text>"}]}.
The items array must contain each style exactly once.
Style rules:
- haiku: exactly three short lines separated by newline characters; use concrete imagery from the changed area.
- sarcastic_summary: one mildly sarcastic sentence about the work, not the author.
- dry_release_note: one plain professional sentence that could appear in release notes.
- tiny_changelog: one or two compact lines, no markdown bullets, focused on what changed.
- commit_fortune: one short fortune-cookie sentence about the change.
- original_song_line: one original song-like line, not a quote and not an artist reference.
- code_joke: one short original joke based on the code facts.
Do not include a title, label, explanation, markdown fence, or any mention that you are an AI model.`;
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

function textModelsForEnv(env: Env): PullRequestHaikuTextModel[] {
  const configured = env.PULL_REQUEST_HAIKU_TEXT_MODELS?.split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

  return configured !== undefined && configured.length > 0 ? configured : [...defaultTextModels];
}

function aiGatewayAuthorizationHeader(env: Env): string | null {
  const token = env.CF_AIG_TOKEN?.trim();

  return token === undefined || token.length === 0 ? null : `Bearer ${token}`;
}

async function openRouterGatewayChatCompletionsUrl(env: Env): Promise<string | null> {
  if (env.AI === undefined) {
    return null;
  }

  const gatewayId = env.PULL_REQUEST_HAIKU_AI_GATEWAY_ID?.trim() || "chikachow";
  const baseUrl = await env.AI.gateway(gatewayId).getUrl("openrouter");

  return `${baseUrl.replace(/\/$/u, "")}/v1/chat/completions`;
}

async function runTextGeneration(
  fetcher: typeof fetch,
  endpoint: string,
  gatewayAuthorization: string | null,
  input: OpenRouterChatCompletionInput,
): Promise<unknown> {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (gatewayAuthorization !== null) {
    headers.set("cf-aig-authorization", gatewayAuthorization);
  }

  const response = await fetcher(endpoint, {
    body: JSON.stringify(input),
    headers,
    method: "POST",
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenRouter Gateway request failed with ${response.status}: ${responseText.slice(0, 1000)}`,
    );
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new Error("OpenRouter Gateway returned non-JSON response");
  }
}

function generationMetadataForTextGeneration(
  model: PullRequestHaikuTextModel,
  result: unknown,
): PullRequestHaikuGenerationMetadata {
  const usage = textGenerationTokenUsage(result);

  return {
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    inputTokens: usage?.inputTokens ?? null,
    model,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
}

function textGenerationTokenUsage(result: unknown): TextGenerationTokenUsage | null {
  if (!isRecord(result)) {
    return null;
  }

  const usage = result["usage"];

  if (!isRecord(usage)) {
    return null;
  }

  return {
    cachedInputTokens: cachedInputTokens(usage),
    inputTokens: integerValue(usage["prompt_tokens"] ?? usage["input_tokens"]),
    outputTokens: integerValue(usage["completion_tokens"] ?? usage["output_tokens"]),
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

    const content = textFromContentValue(value["content"]);

    if (content !== null) {
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

export function normalizedCommentary(value: string, fallback: PullRequestHaiku): PullRequestHaiku {
  const payload = commentaryPayload(value);

  if (payload === null) {
    return fallback;
  }

  return completeCommentary(payload, fallback);
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

function commentaryPayload(value: string): PullRequestHaiku | null {
  const normalized = stripThinkingBlocks(value).trim();
  const parsed = parseJsonObject(normalized);

  if (parsed === null) {
    return {
      items: [
        {
          style: "haiku",
          text: normalizedHaikuString(normalized, ""),
        },
      ],
    };
  }

  const items = commentaryItems(parsed["items"]);

  return items === null ? null : { items };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function commentaryStyle(value: unknown): PullRequestCommentaryStyle | null {
  return typeof value === "string" && isCommentaryStyle(value) ? value : null;
}

function commentaryItems(value: unknown): PullRequestCommentaryItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items: PullRequestCommentaryItem[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const style = commentaryStyle(item["style"]);
    const text = item["text"];

    if (style === null || typeof text !== "string") {
      continue;
    }

    items.push({ style, text });
  }

  return items.length === 0 ? null : items;
}

function isCommentaryStyle(value: string): value is PullRequestCommentaryStyle {
  return commentaryStyles.some((style) => style === value);
}

function completeCommentary(
  commentary: PullRequestHaiku,
  fallback: PullRequestHaiku,
): PullRequestHaiku {
  const validItems = new Map<PullRequestCommentaryStyle, PullRequestCommentaryItem>();

  for (const item of commentary.items) {
    if (!validItems.has(item.style) && validCommentaryItem(item)) {
      validItems.set(item.style, normalizedCommentaryItem(item));
    }
  }

  const fallbackItems = new Map(fallback.items.map((item) => [item.style, item]));

  return {
    items: commentaryStyles
      .map((style) => validItems.get(style) ?? fallbackItems.get(style))
      .filter((item): item is PullRequestCommentaryItem => item !== undefined),
  };
}

function normalizedCommentaryItem(item: PullRequestCommentaryItem): PullRequestCommentaryItem {
  switch (item.style) {
    case "haiku":
    case "tiny_changelog":
      return {
        ...item,
        text: normalizedMultilineText(item.text),
      };
    case "code_joke":
    case "commit_fortune":
    case "dry_release_note":
    case "original_song_line":
    case "sarcastic_summary":
      return {
        ...item,
        text: normalizedSingleLine(item.text),
      };
  }
}

function validCommentaryItem(item: PullRequestCommentaryItem): boolean {
  switch (item.style) {
    case "haiku":
      return normalizedHaikuString(item.text, "") === item.text;
    case "sarcastic_summary":
    case "code_joke":
      return validSingleLineCommentary(item.text, 180);
    case "commit_fortune":
    case "dry_release_note":
    case "original_song_line":
      return validSingleLineCommentary(item.text, 160);
    case "tiny_changelog":
      return validTinyChangelog(item.text);
  }
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

function validSingleLineCommentary(value: string, maxLength: number): boolean {
  const line = normalizedSingleLine(value);

  return (
    line === value &&
    line.length > 0 &&
    line.length <= maxLength &&
    !/```/u.test(line) &&
    !line.includes("\n")
  );
}

function validTinyChangelog(value: string): boolean {
  const lines = value
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);

  return (
    lines.length >= 1 &&
    lines.length <= 2 &&
    lines.every((line) => line.length <= 120 && !/```/u.test(line) && !/^\s*[-*]\s+/u.test(line))
  );
}

function normalizedMultilineText(value: string): string {
  return value
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizedSingleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
