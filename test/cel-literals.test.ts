import { describe, expect, it } from "vitest";

import { celString } from "../workers/cyspbot-token-exchange/src/policy/cel-literals.ts";

describe("CEL literals", () => {
  it("encodes quotes, backslashes, and control characters as a CEL string", () => {
    expect(celString('line\n"quoted"\\tail')).toBe('"line\\n\\"quoted\\"\\\\tail"');
  });
});
