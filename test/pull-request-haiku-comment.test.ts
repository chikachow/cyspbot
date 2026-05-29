import { describe, expect, it } from "vitest";

import { renderPullRequestHaikuComment } from "../src/pull-request-haiku/comment.ts";

describe("pull request haiku comments", () => {
  it("renders haikus as centered escaped poem HTML", () => {
    expect(
      renderPullRequestHaikuComment({
        haiku: {
          items: [
            {
              style: "haiku",
              text: 'Queue <winds> softly\nBranches & tests bloom\nReview waits "calm"',
            },
            {
              style: "code_joke",
              text: "The queue promised to be brief, then brought tests.",
            },
          ],
        },
        pullRequest: {
          additions: 10,
          changedFiles: 2,
          deletions: 4,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          number: 2,
        },
        repositoryId: 123456789,
      }),
    ).toBe(`<!-- cyspbot:pull-request-haiku repository_id=123456789 pull_request=2 -->
<!-- cyspbot:pull-request-commentary-styles haiku,code_joke -->
<p align="center">
  <strong>Haiku</strong><br>
  <em>Queue &lt;winds&gt; softly<br>
  Branches &amp; tests bloom<br>
  Review waits &quot;calm&quot;</em>
</p>

<p align="center">
  <strong>Code joke</strong><br>
  <em>The queue promised to be brief, then brought tests.</em>
</p>`);
  });

  it("renders cost estimates as hidden comment metadata", () => {
    expect(
      renderPullRequestHaikuComment({
        costEstimate: {
          cachedInputTokens: null,
          estimatedCostUsd: 0.0000577,
          estimatedNeurons: 5.2345,
          inputTokens: 1000,
          inputUsdPerMillionTokens: 0.051,
          model: "@cf/qwen/qwen3-30b-a3b-fp8",
          outputTokens: 20,
          outputUsdPerMillionTokens: 0.335,
          scope: "prompt",
          totalTokens: 1020,
        },
        haiku: {
          items: [
            {
              style: "dry_release_note",
              text: "Queue winds softly",
            },
          ],
        },
        pullRequest: {
          additions: 10,
          changedFiles: 2,
          deletions: 4,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          number: 2,
        },
        repositoryId: 123456789,
      }),
    ).toContain(
      '<!-- cyspbot:pull-request-haiku-cost {"cachedInputTokens":null,"estimatedCostUsd":0.0000577,"estimatedNeurons":5.2345,"inputTokens":1000,"inputUsdPerMillionTokens":0.051,"model":"@cf/qwen/qwen3-30b-a3b-fp8","outputTokens":20,"outputUsdPerMillionTokens":0.335,"scope":"prompt","totalTokens":1020} -->',
    );
    expect(
      renderPullRequestHaikuComment({
        haiku: {
          items: [
            {
              style: "dry_release_note",
              text: "Queue winds softly",
            },
          ],
        },
        pullRequest: {
          additions: 10,
          changedFiles: 2,
          deletions: 4,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          number: 2,
        },
        repositoryId: 123456789,
      }),
    ).toContain("<!-- cyspbot:pull-request-commentary-styles dry_release_note -->");
  });
});
