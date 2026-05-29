import { describe, expect, it } from "vitest";

import { normalizedHaikuString } from "../src/pull-request-haiku/processor.ts";

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
});
