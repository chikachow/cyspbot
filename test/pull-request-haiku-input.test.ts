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
