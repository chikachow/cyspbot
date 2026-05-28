import { describe, expect, it } from "vitest";

import { renderPullRequestHaikuComment } from "../src/pull-request-haiku/comment.ts";

describe("pull request haiku comments", () => {
  it("renders haikus as centered escaped poem HTML", () => {
    expect(
      renderPullRequestHaikuComment({
        haiku: {
          text: 'Queue <winds> softly\nBranches & tests bloom\nReview waits "calm"',
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
<p align="center">
  <em>Queue &lt;winds&gt; softly<br>
  Branches &amp; tests bloom<br>
  Review waits &quot;calm&quot;</em>
</p>`);
  });
});
