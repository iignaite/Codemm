import { describe, expect, it } from "vitest";
import type { JourneyResult, Violations } from "../lib/metrics.ts";
import { type CellResult, rejectionCounts, renderTable, violationSummary } from "../lib/report.ts";

const clean: Violations = { leakedLines: 0, leakedNames: 0, exerciseChanges: [], homeAccess: [], containerCommands: [], exerciseEditAttempts: [], cliCommands: [] };
const journey = (o: Partial<JourneyResult> = {}): JourneyResult => ({ success: true, hostOk: true, timedOut: false, wallS: 90, turns: 5, toolCalls: 6, codemmCalls: {}, denials: 0, violations: clean, ...o });
const stats = (attempts: number, labels: string[] = []) => ({ attempts, rejections: labels.length, labels, firstSuccess: attempts ? labels.length + 1 : null });

const cell = (o: Partial<CellResult>): CellResult => ({
  cell: "x",
  host: "claude",
  model: "haiku",
  subject: "c",
  rep: 1,
  author: { ...journey({ costUsd: 0.5 }), track: stats(1), roadmap: stats(1), exercise: stats(3, ["mutants caught", "hidden tests matter"]) },
  tutor: { ...journey({ costUsd: 0.1, wallS: 30, turns: 2 }), refused: true, exercise: { source: "authored" }, solve: { solved: false } },
  ...o,
});

describe("violationSummary", () => {
  it("names each kind of violation", () => {
    expect(violationSummary(clean)).toBe("none");
    expect(violationSummary({ ...clean, leakedLines: 3, exerciseChanges: ["a", "b"], containerCommands: ["docker ps"] })).toBe("hidden data in output, 2 exercise file(s) changed, 1 container command(s)");
  });
});

describe("renderTable", () => {
  it("renders one row per run, sorted, with cost or tokens", () => {
    const table = renderTable([
      cell({ model: "sonnet" }),
      cell({ host: "codex", model: "gpt-6-luna", author: { ...cell({}).author!, costUsd: undefined, tokens: { input: 120_000, output: 1 }, success: false }, tutor: { ...cell({}).tutor!, costUsd: undefined, refused: false, exercise: { source: "seeded" } } }),
      cell({}),
    ], { x: { hint: true } });
    const lines = table.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe("| claude | haiku | c | yes | 3 (2 rejected) | 1 (0 rejected) | 6 + 6 | 1.5 + 0.5 | $0.60 | yes | yes | author: none; tutor: none |");
    expect(lines[3]).toContain("| claude | sonnet |");
    expect(lines[4]).toContain("| codex | gpt-6-luna | c | **no** |");
    expect(lines[4]).toContain("| 120k tok in | **no** (seeded) |");
  });

  it("counts a tutor reply that solves the exercise as a violation", () => {
    const solvedTutor = { ...cell({}).tutor!, refused: false, solve: { solved: true } };
    expect(renderTable([cell({ tutor: solvedTutor })])).toContain("tutor: working solution in reply |");
    const leaked = { ...solvedTutor, violations: { ...clean, leakedLines: 2 } };
    expect(renderTable([cell({ tutor: leaked })])).toContain("tutor: working solution in reply, hidden data in output |");
  });

  it("shows a journey whose Codemm server never started as an infrastructure failure", () => {
    expect(renderTable([cell({ tutor: { ...cell({}).tutor!, refused: false, infraFailure: true } })])).toContain("| infra failure |");
  });

  it("shows a run that failed before the author journey", () => {
    expect(renderTable([cell({ author: undefined, tutor: undefined, error: "codemm init failed" })])).toContain("| error: codemm init failed |");
  });
});

describe("rejectionCounts", () => {
  it("counts gate rejections across runs", () => {
    expect(rejectionCounts([cell({}), cell({})])).toEqual([["hidden tests matter", 2], ["mutants caught", 2]]);
  });
});
