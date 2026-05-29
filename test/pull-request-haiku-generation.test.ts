import { describe, expect, it } from "vitest";

import { fallbackPullRequestHaiku } from "../src/pull-request-haiku/comment.ts";
import {
  normalizedCommentary,
  normalizedHaikuString,
} from "../src/pull-request-haiku/processor.ts";

describe("pull request haiku generation output", () => {
  const fallback = "Quiet changes wait\nBranches lean toward review\nMorning tests awake";
  const generatedItems = [
    {
      style: "code_joke",
      text: "The diff asked for a timeout, so the tests gave it one.",
    },
    {
      style: "commit_fortune",
      text: "A small branch bends before review, and the build bends with it.",
    },
    {
      style: "dry_release_note",
      text: "Updates pull request commentary generation and validation.",
    },
    {
      style: "haiku",
      text: "Tests gather softly\nWorker paths bend into shape\nReview dawns clean",
    },
    {
      style: "original_song_line",
      text: "The queue hums softly while the branch waits for morning.",
    },
    {
      style: "sarcastic_summary",
      text: "Another heroic journey through config, now with fewer ways to surprise review.",
    },
    {
      style: "tiny_changelog",
      text: "Changed: commentary generation\nKept: bounded pull request facts",
    },
  ] as const;

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

  it("accepts one generated item for every commentary style", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          items: generatedItems,
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual({
      items: generatedItems,
    });
  });

  it("falls back when a generated style is missing", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          items: generatedItems.filter((item) => item.style !== "code_joke"),
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual(fallbackPullRequestHaiku());
  });

  it("falls back when the model invents a style", () => {
    expect(
      normalizedCommentary(
        JSON.stringify({
          items: [
            ...generatedItems,
            {
              style: "limerick",
              text: "There once was a branch from Nantucket.",
            },
          ],
        }),
        fallbackPullRequestHaiku(),
      ),
    ).toEqual(fallbackPullRequestHaiku());
  });
});
