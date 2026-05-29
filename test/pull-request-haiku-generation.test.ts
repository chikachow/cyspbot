import { describe, expect, it } from "vitest";

import { fallbackPullRequestHaiku } from "../src/pull-request-haiku/comment.ts";
import {
  normalizedCommentary,
  normalizedHaikuString,
} from "../src/pull-request-haiku/processor.ts";

describe("pull request haiku generation output", () => {
  const fallback = "Quiet changes wait\nBranches lean toward review\nMorning tests awake";

  it("normalizes valid three-line haikus", () => {
    expect(
      normalizedHaikuString(
        "<think>pick an image</think>\n  Tests gather softly  \n\nWorker paths bend\nReview dawns clean",
        fallback,
      ),
    ).toBe("Tests gather softly\nWorker paths bend\nReview dawns clean");
  });

  it("falls back when the model adds labels or extra prose", () => {
    expect(
      normalizedHaikuString(
        "Haiku:\nTests gather softly\nWorker paths bend\nReview dawns clean",
        fallback,
      ),
    ).toBe(fallback);
  });

  it("falls back when the model returns the wrong number of lines", () => {
    expect(normalizedHaikuString("Tests gather softly\nWorker paths bend", fallback)).toBe(
      fallback,
    );
  });

  it("falls back when output mentions model mechanics", () => {
    expect(
      normalizedHaikuString("As an AI model\nTests gather softly\nReview dawns clean", fallback),
    ).toBe(fallback);
  });

  it("accepts model-selected sarcastic summaries from structured JSON", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          style: "sarcastic_summary",
          text: "Another heroic journey through config, now with fewer ways to surprise review.",
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual({
      style: "sarcastic_summary",
      text: "Another heroic journey through config, now with fewer ways to surprise review.",
    });
  });

  it("accepts short code jokes from structured JSON", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          style: "code_joke",
          text: "The diff asked for a timeout, so the tests gave it one.",
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual({
      style: "code_joke",
      text: "The diff asked for a timeout, so the tests gave it one.",
    });
  });

  it("falls back when the model invents a style", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          style: "limerick",
          text: "There once was a branch from Nantucket.",
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual(fallbackPullRequestHaiku());
  });

  it("accepts original song-like lines from structured JSON", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          style: "original_song_line",
          text: "The queue hums softly while the branch waits for morning.",
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual({
      style: "original_song_line",
      text: "The queue hums softly while the branch waits for morning.",
    });
  });
});
