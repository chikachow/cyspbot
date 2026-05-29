#!/usr/bin/env node

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.PULL_REQUEST_HAIKU_TEXT_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8";

if (!accountId || !apiToken) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before running this probe.");
  process.exit(1);
}

const facts = {
  changed_files: 6,
  files: [
    {
      additions: 110,
      deletions: 420,
      filename: "src/pull-request-haiku/processor.ts",
      status: "modified",
    },
    {
      additions: 20,
      deletions: 90,
      filename: "src/pull-request-haiku/comment.ts",
      status: "modified",
    },
    {
      additions: 8,
      deletions: 36,
      filename: "wrangler.jsonc",
      status: "modified",
    },
    {
      additions: 24,
      deletions: 58,
      filename: "test/worker.test.ts",
      status: "modified",
    },
  ],
  stats: {
    additions: 162,
    deletions: 604,
  },
};

const inputPayload = {
  facts,
  kind: "facts_only",
  summary: {
    change_shape: "mostly_deletion",
    dominant_area: "src/pull-request-haiku",
    file_groups: [
      {
        additions: 130,
        area: "src/pull-request-haiku",
        deletions: 510,
        files: 2,
      },
      {
        additions: 24,
        area: "test/worker.test.ts",
        deletions: 58,
        files: 1,
      },
      {
        additions: 8,
        area: "wrangler.jsonc",
        deletions: 36,
        files: 1,
      },
    ],
    notable_statuses: ["modified"],
  },
};

const input = {
  max_tokens: 100,
  messages: [
    {
      content: `You write one short pull request commentary item from code-related pull request facts.
Choose exactly one style from this enum: code_joke, commit_fortune, dry_release_note, haiku, original_song_line, sarcastic_summary, tiny_changelog.
Use the style that best fits the change, but stay grounded in the provided code facts and diff context.
The facts intentionally exclude human-authored pull request text such as titles, descriptions, branch names, and commit messages.
The input includes changed-file facts and a local summary only. Do not imply you inspected patch contents.
Do not spend tokens on reasoning. Return the JSON object directly. /no_think

Return only compact JSON with this exact shape: {"style":"haiku","text":"..."}.
Style rules:
- haiku: exactly three short lines separated by newline characters, haiku-like imagery over strict syllable counting.
- sarcastic_summary: one mildly sarcastic sentence about the change, never cruel, personal, profane, or hostile.
- dry_release_note: one dry professional sentence.
- tiny_changelog: one or two compact lines, no markdown bullets.
- commit_fortune: one short fortune-cookie sentence about the change.
- original_song_line: one original song-like line, no real song lyrics, no artist names, no quoted or recognizable lyrics.
- code_joke: one short original joke based on the code facts, no insults, no profanity, no real song lyrics.
Do not include a title, label, explanation, markdown fence, or any mention that you are an AI model.`,
      role: "system",
    },
    {
      content: `/no_think\n${JSON.stringify(inputPayload)}`,
      role: "user",
    },
  ],
  temperature: 0.75,
  top_p: 0.9,
};

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
  {
    body: JSON.stringify(input),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  },
);

const body = await response.json();

console.log("status", response.status);
console.log("raw response");
console.log(JSON.stringify(body, null, 2));
console.log("extracted haiku");
console.log(textGenerationResponsePayload(body.result ?? body) ?? "<no text payload>");

function textGenerationResponsePayload(result) {
  if (typeof result === "string") {
    return result;
  }

  if (!isRecord(result)) {
    return null;
  }

  const responseValue = result.response;

  if (typeof responseValue === "string") {
    return responseValue;
  }

  if (isRecord(responseValue)) {
    return JSON.stringify(responseValue);
  }

  const choices = choicesList(result.choices);

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

function choicesList(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return isRecord(value) ? Object.values(value) : null;
}

function choiceContent(choice) {
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

    const content = value.content;

    const text = textFromContentValue(content);

    if (text !== null) {
      return text;
    }
  }

  return null;
}

function textFromContentValue(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value.map((part) => textFromContentValue(part)).filter((part) => part !== null);

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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
