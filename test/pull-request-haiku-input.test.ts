import { describe, expect, it } from "vitest";

import { buildPullRequestHaikuInput } from "../src/pull-request-haiku/input.ts";

describe("pull request haiku model input", () => {
  it("includes bounded code diff hunks when patches are available", () => {
    const input = buildPullRequestHaikuInput({
      files: [
        {
          additions: 1,
          changes: 1,
          deletions: 0,
          filename: "src/worker/app.ts",
          patch: "@@ -1,2 +1,3 @@\n import { createApp } from './app';\n+export { createApp };",
          status: "modified",
        },
      ],
      pullRequest: {
        additions: 1,
        changedFiles: 1,
        deletions: 0,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        number: 12,
      },
    });

    expect(input.kind).toBe("diff_full");
    expect(input).toMatchObject({
      diff: expect.stringContaining("diff --git a/src/worker/app.ts b/src/worker/app.ts"),
      summary: {
        change_shape: "mostly_addition",
        dominant_area: "src/worker",
        file_groups: [
          {
            additions: 1,
            area: "src/worker",
            deletions: 0,
            files: 1,
          },
        ],
        notable_statuses: ["modified"],
      },
    });
  });

  it("truncates diff hunks when the prompt budget would be exceeded", () => {
    const input = buildPullRequestHaikuInput({
      files: [
        {
          additions: 1,
          changes: 1,
          deletions: 0,
          filename: "src/worker/app.ts",
          patch: "@@ -1 +1 @@\n+small",
          status: "modified",
        },
        {
          additions: 5000,
          changes: 5000,
          deletions: 0,
          filename: "src/generated/large.ts",
          patch: `@@ -1 +1 @@\n+${"x".repeat(3000)}`,
          status: "modified",
        },
      ],
      maxModelInputTokens: 300,
      pullRequest: {
        additions: 5001,
        changedFiles: 2,
        deletions: 0,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        number: 12,
      },
    });

    expect(input).toMatchObject({
      diff: expect.stringContaining("src/worker/app.ts"),
      kind: "diff_truncated",
      omitted_files: 1,
    });
    expect(JSON.stringify(input)).not.toContain("x".repeat(3000));
  });

  it("prioritizes representative source hunks over low-signal generated changes", () => {
    const input = buildPullRequestHaikuInput({
      files: [
        {
          additions: 2000,
          changes: 2000,
          deletions: 0,
          filename: "src/generated/client.ts",
          patch: `@@ -1 +1 @@\n+${"x".repeat(800)}`,
          status: "modified",
        },
        {
          additions: 4,
          changes: 4,
          deletions: 0,
          filename: "src/pull-request-haiku/input.ts",
          patch: "@@ -1 +1 @@\n+const summary = true;",
          status: "modified",
        },
      ],
      maxModelInputTokens: 520,
      pullRequest: {
        additions: 2004,
        changedFiles: 2,
        deletions: 0,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        number: 12,
      },
    });

    expect(input).toMatchObject({
      kind: "diff_truncated",
      omitted_files: 1,
      summary: {
        dominant_area: "src/generated",
      },
    });
    if (input.kind !== "diff_truncated") {
      throw new Error(`expected diff_truncated input, got ${input.kind}`);
    }
    expect(input.diff).toContain("src/pull-request-haiku/input.ts");
    expect(input.diff).not.toContain("src/generated/client.ts");
  });

  it("falls back to facts only when no diff hunk fits the prompt budget", () => {
    expect(
      buildPullRequestHaikuInput({
        files: [
          {
            additions: 5000,
            changes: 5000,
            deletions: 0,
            filename: "src/generated/large.ts",
            patch: `@@ -1 +1 @@\n+${"x".repeat(3000)}`,
            status: "modified",
          },
        ],
        maxModelInputTokens: 300,
        pullRequest: {
          additions: 5000,
          changedFiles: 1,
          deletions: 0,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          number: 12,
        },
      }),
    ).toMatchObject({ kind: "facts_only" });
  });
});
