import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseFrames } from "../src/grading.js";
import { redact } from "../src/grading.js";
import { judgeSets, runIo, runUnit } from "../src/judge.js";
import { runsDir } from "../src/runs.js";
import { readdirSync, existsSync } from "node:fs";
import { tempDir } from "./temp.js";
import { wasiTrack, wasmtimeUp } from "./wasi-engine.js";

/** A WASI track's checks (DESIGN §4.5): one wasmtime process per io case, graded as Docker's are. */

const src = { "main.txt": "learner file" };
const inputs = { "01.in": "one\n", "02.in": "two\n" };

describe("a WASI track's limits", () => {
  it("refuses unit tests", async () => {
    await expect(runUnit({ ...wasiTrack("cat"), test: "x" }, src, {})).rejects.toThrow(/WASI.*io/);
  });

  it("refuses a build", async () => {
    await expect(runIo({ ...wasiTrack("cat"), build: "make" }, "visible", src, inputs)).rejects.toThrow(/WASI.*build/);
  });

  it("refuses input generators", async () => {
    await expect(runIo(wasiTrack("cat"), "visible", src, { "01.gen": "echo 1" })).rejects.toThrow(/WASI.*generat/);
  });
});

describe("a WASI check without wasmtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is an infrastructure error, so nothing is graded or recorded", async () => {
    vi.stubEnv("CODEMM_WASMTIME", `${tempDir()}/no-wasmtime`);
    await expect(runIo(wasiTrack("cat"), "visible", src, inputs)).rejects.toMatchObject({ code: "no-wasmtime" });
  });
});

describe.skipIf(!wasmtimeUp)("a WASI check", () => {
  const expected = (set: "visible" | "hidden") => ({ [`${set}/01`]: "one", [`${set}/02`]: "two" });

  it("pipes each input to its own run and grades the output", async () => {
    const tests = await judgeSets(wasiTrack("cat"), "io", src, { visible: inputs, hidden: inputs }, { expected: { ...expected("visible"), ...expected("hidden") } });
    expect(tests.map((t) => [t.name, t.status])).toEqual([["visible/01", "pass"], ["visible/02", "pass"], ["hidden/01", "pass"], ["hidden/02", "pass"]]);
  });

  it("reports progress and each finished case as it goes, as for Docker", async () => {
    const milestones: (number | "built")[] = [];
    const cases: CaseFrames[] = [];
    await runIo(wasiTrack("cat"), "visible", src, inputs, { onProgress: (m) => milestones.push(m), onCase: (c) => cases.push(c) });
    expect(milestones).toEqual([1, 2]);
    expect(cases.map((c) => [c.name, c.exit, c.stdout])).toEqual([["01", 0, "one\n"], ["02", 0, "two\n"]]);
  });

  it("says how a program ended in words, naming the learner's files as they know them", async () => {
    const [t] = await judgeSets(wasiTrack("fail"), "io", src, { visible: { "01.in": "" } }, { expected: { "visible/01": "partial" } });
    expect(t).toMatchObject({ status: "error", actual: "partial\n" });
    expect(t!.message).toBe("It stopped with an error:\nboom in main.txt\n");
  });

  it("grades a case that reaches its time limit as a time-out", async () => {
    const [t] = await judgeSets(wasiTrack("loop", { time_ms: 300, memory_mb: 256 }), "io", src, { visible: { "01.in": "" } }, { expected: { "visible/01": "x" } });
    expect(t).toMatchObject({ status: "error", message: "It took longer than 300 ms" });
  });

  it("grades a case that prints more than the per-case limit as a flood", async () => {
    const [t] = await judgeSets(wasiTrack("flood"), "io", src, { visible: { "01.in": "" } }, { expected: { "visible/01": "x" } });
    expect(t).toMatchObject({ status: "error", message: "Printed more than 32 MB of output." });
  });

  it("grades a program that runs out of memory by its own error", async () => {
    const [t] = await judgeSets(wasiTrack("grow", { time_ms: 2000, memory_mb: 64 }), "io", src, { visible: { "01.in": "" } }, { expected: { "visible/01": "grown" } });
    expect(t).toMatchObject({ status: "error", message: "It stopped with an error:\nno memory\n" });
  });

  it("stops a set at its first error when asked", async () => {
    const run = await runIo(wasiTrack("fail"), "visible", src, { "01.in": "", "02.in": "", "03.in": "" }, { stopAtError: true });
    expect(run.cases.map((c) => c.name)).toEqual(["visible/01"]);
  });

  it("shows nothing of a hidden case but its index and status", async () => {
    const tests = await judgeSets(wasiTrack("fail"), "io", src, { hidden: { "01.in": "" } }, { expected: { "hidden/01": "x" } });
    expect(redact(tests)).toEqual([{ name: "hidden #1", index: 1, status: "error" }]);
  });

  it("removes its run folder, though the program saw it read-only", async () => {
    await runIo(wasiTrack("cat"), "visible", src, inputs);
    const mine = existsSync(runsDir()) ? readdirSync(runsDir()).filter((n) => n.startsWith(`${process.pid}-`)) : [];
    expect(mine).toEqual([]);
  });
});
