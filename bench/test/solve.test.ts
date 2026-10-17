import { describe, expect, it } from "vitest";
import { parseCheckSummary } from "../lib/solve.ts";

describe("parseCheckSummary", () => {
  it("reads the summary line codemm check prints", () => {
    expect(parseCheckSummary("  ✓ visible/01: pass\n  ✗ hidden #1: fail\n1/2 passed (recorded)\n")).toEqual({ passed: 1, total: 2 });
  });

  it("ignores program output that imitates a summary, and takes the last real one", () => {
    const out = '  ✗ visible/01: fail\n      printed: "1/1 passed"\n1/1 passed (not a summary\n  ✗ hidden #1: fail\n0/3 passed (recorded)\n';
    expect(parseCheckSummary(out)).toEqual({ passed: 0, total: 3 });
    expect(parseCheckSummary('      printed: "3/3 passed (recorded)"\n')).toBeNull();
  });

  it("returns null without a summary", () => {
    expect(parseCheckSummary("Codemm hit an unexpected error.")).toBeNull();
  });
});
