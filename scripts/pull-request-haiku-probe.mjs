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

const input = {
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
      content: `/no_think\n${JSON.stringify(facts)}`,
      role: "user",
    },
  ],
  temperature: 0.85,
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
