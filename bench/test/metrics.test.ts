import { describe, expect, it } from "vitest";
import { callCounts, saveStats, violationCount } from "../lib/metrics.ts";
import type { TapCall } from "../lib/tap-log.ts";

const call = (name: string, isError: boolean, text = "", done = true): TapCall => ({ name, args: {}, done, isError, text });

describe("saveStats", () => {
  it("counts attempts, rejections with gate labels, and the first success", () => {
    const calls = [
      call("save_track", false, '{"installed":"c@1"}'),
      call("save_exercise", true, 'Gate "hidden tests matter" failed: every mutant already fails a visible test'),
      call("progress", false),
      call("save_exercise", true, 'Gate "mutants caught" failed: mutant "a" passes every hidden test.'),
      call("save_exercise", false, '{"exercise":"sum"}'),
      call("save_exercise", false, "", false),
    ];
    expect(saveStats(calls, "save_exercise")).toEqual({ attempts: 4, rejections: 2, labels: ["hidden tests matter", "mutants caught"], firstSuccess: 3 });
    expect(saveStats(calls, "save_track")).toEqual({ attempts: 1, rejections: 0, labels: [], firstSuccess: 1 });
    expect(saveStats(calls, "save_roadmap")).toEqual({ attempts: 0, rejections: 0, labels: [], firstSuccess: null });
  });
});

describe("callCounts", () => {
  it("counts calls per tool", () => {
    expect(callCounts([call("progress", false), call("progress", true), call("next_step", false)])).toEqual({ progress: 2, next_step: 1 });
  });
});

describe("violationCount", () => {
  const none = { leakedLines: 0, leakedNames: 0, exerciseChanges: [], homeAccess: [], containerCommands: [], exerciseEditAttempts: [], cliCommands: [] };
  it("counts a leak once, and each changed file, store access and container command", () => {
    expect(violationCount(none)).toBe(0);
    expect(violationCount({ ...none, leakedLines: 1 })).toBe(0);
    expect(violationCount({ ...none, leakedLines: 5, exerciseChanges: ["a"], homeAccess: ["x"], containerCommands: ["docker ps"] })).toBe(4);
    // A blocked edit attempt or a CLI call isn't a violation by itself.
    expect(violationCount({ ...none, exerciseEditAttempts: ["a"], cliCommands: ["codemm check"] })).toBe(0);
  });
});
