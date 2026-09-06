import { describe, expect, it } from "vitest";

import rootHarness from "./support/root-test-harness.ts";

describe("worker entrypoint shapes", () => {
  it("does not route product endpoints through the root test harness", async () => {
    const response = await Promise.resolve(
      rootHarness.fetch(
        new Request("https://example.test/github/webhooks"),
        {},
        {} as ExecutionContext,
      ),
    );

    expect(response.status).toBe(404);
  });
});
