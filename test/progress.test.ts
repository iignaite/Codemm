import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import type { CheckProgress } from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { parseTrackYaml } from "../src/schemas.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

/** Check progress: io reports each test as it finishes; hidden tests are counted, never named. */

const fixtures = join(import.meta.dirname, "fixtures");

beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", tempDir("codemm-home-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(posix)("check progress", () => {
  it("reports the build, then each visible io test as it finishes, then the hidden phase without counts", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: (CheckProgress & { at: number })[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push({ ...p, at: Date.now() }));
    expect(seen.map(({ phase, done, total, test }) => [phase, done, total, test?.status])).toEqual([
      ["building", 0, 0, undefined],
      ["visible", 0, 1, undefined],
      ["visible", 1, 1, undefined],
      ["visible", 1, 1, "fail"],
      ["hidden", 0, 0, undefined],
    ]);
    // Streamed, not reported all at once when the container exits: the fake waits 0.2 s after the build.
    const visible = seen.filter((p) => p.phase === "visible");
    expect(visible[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(150);
  });

  it("keeps checking when a progress listener throws, and records the attempt", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const view = await app.checkExercise(ws, undefined, undefined, () => {
      throw new Error("listener bug");
    });
    expect(view.recorded).toBe(true);
    expect(store.readEvents("shell")).toHaveLength(1);
  });

  // Root writes anywhere, so a read-only folder can't stand in for a full disk there.
  it.runIf(process.getuid?.() !== 0)("records nothing when the workspace can't be updated, so \"not counted\" stays true and a retry counts once", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    // A read-only workspace folder: grading still runs (it writes only inside exercises/), but codemm.json can't be
    // written, as on a full disk.
    chmodSync(ws, 0o555);
    try {
      await expect(app.checkExercise(ws)).rejects.toThrow();
    } finally {
      chmodSync(ws, 0o755);
    }
    expect(store.readEvents("shell")).toEqual([]);
    // Once the disk is fine again, the retry is the one counted attempt.
    await app.checkExercise(ws);
    expect(store.readEvents("shell").filter((e) => e.kind === "check")).toHaveLength(1);
  });

  it("records nothing when Docker fails mid-check, whatever progress was reported", async () => {
    const ws = await installedExercise();
    fakeDocker("killed");
    const seen: CheckProgress[] = [];
    await expect(app.checkExercise(ws, undefined, undefined, (p) => seen.push(p))).rejects.toMatchObject({ kind: "docker", message: expect.stringMatching(/wasn't counted/) });
    expect(seen.length).toBeGreaterThan(0);
    expect(store.readEvents("shell")).toEqual([]);
  });

  it("carries each visible test's result as it finishes; hidden progress carries a phase and counts only", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(seen.filter((p) => p.test)).toEqual([
      { phase: "visible", done: 1, total: 1, test: { name: "visible/01", status: "fail", message: "Output differs from the expected output.", actual: "0\n" } },
    ]);
    for (const p of seen.filter((p) => !p.test)) expect(Object.keys(p).sort()).toEqual(["done", "phase", "total"]);
    for (const p of seen.filter((p) => p.phase === "hidden")) expect(p).toEqual({ phase: "hidden", done: 0, total: 0 });
  });

  it("keeps hidden data out of results, progress, recorded misses and the author's last check", async () => {
    const ws = await installedExercise();
    await app.saveRoadmap(ws, "shell", "goal: Loops\ntrack: shell-io@1\nstyle: io\nconcepts: [{ id: sh.loops, title: Loops }]\n");
    // The learner is at difficulty 1; this task is difficulty 2. The middle hidden case passes.
    const { record } = store.readExercise("shell", "max-of-line");
    writeFileSync(join(store.exerciseDir("shell", record.slug), "exercise.json"), JSON.stringify({ ...record, difficulty: 2, expected: { ...record.expected, "hidden/01": "HIDDEN-EXPECTED\n", "hidden/02": "0\n" } }));
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    const view = await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    const hidden = view.tests.filter((t) => t.name.startsWith("hidden"));
    expect(hidden.map((t) => Object.keys(t).sort())).toEqual([["index", "name", "status"], ["index", "name", "status"], ["index", "name", "status"]]);
    expect(hidden.map((t) => [t.name, t.index])).toEqual([["hidden #1", 1], ["hidden #2", 2], ["hidden #3", 3]]);
    const missed = { visible: ["visible/01"], hidden: [1, 3] };
    const events = store.readEvents("shell");
    expect(events).toEqual([expect.objectContaining({ kind: "check", passed: 1, total: 4, missed })]);
    const step = app.nextStep(ws);
    expect(step).toMatchObject({ kind: "author", concept: "sh.loops", difficulty: 1, last: { passed: 1, total: 4, assisted: false, missed } });
    // Nothing from the hidden files: their names, inputs or expected outputs.
    const out = JSON.stringify({ view, seen, events, step });
    for (const secret of ["hidden/01", "hidden/02", "hidden/03", "1 5 2\\n", "-3 -1 -2\\n", "7\\n", "HIDDEN-EXPECTED"]) expect(out).not.toContain(secret);
  });

  it("keeps a failing hidden io test's output and errors in, while a visible one's come out", async () => {
    const ws = await installedExercise();
    const hidden = join(store.exerciseDir("shell", "max-of-line"), "tests", "hidden");
    for (const n of ["01", "02", "03"]) writeFileSync(join(hidden, `${n}.in`), `CANARY ${n}\n`);
    fakeDocker("echoes");
    const seen: CheckProgress[] = [];
    const view = await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    // The visible test shows what the program printed and its errors (the fake echoes the input on both).
    expect(view.tests[0]).toEqual({ name: "visible/01", status: "error", message: expect.stringContaining("3 1 2"), actual: "3 1 2" });
    expect(view.tests.slice(1)).toEqual([1, 2, 3].map((n) => ({ name: `hidden #${n}`, index: n, status: "error" })));
    expect(JSON.stringify({ view, seen })).not.toContain("CANARY");
  });

  it("reports the visible tests only for Try it", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.testExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(seen.map((p) => p.phase)).toEqual(["building", "visible", "visible", "visible"]);
  });
});

describe.runIf(posix)("check progress for unit exercises", () => {
  it("records no missed field on a perfect check", async () => {
    const ws = await unitExercise();
    writeFileSync(join(ws, "exercises", "units", "maxof", "lib.sh"), "# edited\n");
    fakeDocker("streams");
    expect(await app.checkExercise(ws)).toMatchObject({ recorded: true, passed: 2, total: 2 });
    const events = store.readEvents("units");
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("missed");
  });

  it("records at most 50 misses per set, keeping their shown names and indexes", async () => {
    const names = Array.from({ length: 51 }, (_, i) => `case-${i + 1}`);
    // Hidden names of their own, so recording one would show.
    const secrets = Array.from({ length: 51 }, (_, i) => `secret-${i + 1}`);
    // Only t is reported (passing); the other inventory entries are graded as errors.
    const ws = await unitExercise(["t", ...secrets], ["t", ...names]);
    writeFileSync(join(ws, "exercises", "units", "maxof", "lib.sh"), "# edited\n");
    fakeDocker("streams");
    const view = await app.checkExercise(ws);
    expect(view).toMatchObject({ recorded: true, passed: 2, total: 104 });
    expect(store.readEvents("units")).toEqual([expect.objectContaining({
      kind: "check",
      missed: { visible: names.slice(0, 50).map((name) => `visible/${name}`), hidden: Array.from({ length: 50 }, (_, i) => i + 2) },
    })]);
    expect(JSON.stringify({ view, events: store.readEvents("units"), step: app.nextStep(ws) })).not.toContain("secret-");
  });

  it("reports each phase once, with no count, because the runner reports at the end", async () => {
    const ws = await unitExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(seen).toEqual([
      { phase: "visible", done: 0, total: 0 },
      { phase: "hidden", done: 0, total: 0 },
    ]);
  });

  it("masks a hidden unit test's name, even in the result for a test the runner didn't report", async () => {
    const ws = await unitExercise(["secret-edge-case"]);
    fakeDocker("streams");
    const view = await app.checkExercise(ws);
    expect(view.tests.filter((t) => t.name.startsWith("hidden"))).toEqual([{ name: "hidden #1", index: 1, status: "error" }]);
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("keeps a failing hidden unit test's message in, while a visible one's comes out", async () => {
    const ws = await unitExercise();
    const tests = join(store.exerciseDir("units", "maxof"), "tests");
    writeFileSync(join(tests, "visible", "first_is_max.sh"), "VISIBLE text");
    for (const f of ["middle_is_max.sh", "all_negative.sh"]) writeFileSync(join(tests, "hidden", f), `CANARY ${f}`);
    fakeDocker("echoes");
    const seen: CheckProgress[] = [];
    const view = await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(view.tests).toEqual([
      { name: "visible/t", status: "fail", message: expect.stringContaining("VISIBLE text") },
      { name: "hidden #1", index: 1, status: "fail" },
    ]);
    expect(JSON.stringify({ view, seen })).not.toContain("CANARY");
  });
});

describe.runIf(posix)("exercise gate progress", () => {
  it("reports which gate runs, by name only, in order", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: unknown[] = [];
    const files = { ...readFileMap(join(fixtures, "exercises", "io-max")) };
    files["exercise.yaml"] = files["exercise.yaml"]!.replace("max-of-line", "max-again");
    // Every fake run prints the same output, so the starter passes too and its gate fails.
    await expect(app.saveExercise(ws, files, undefined, (p) => seen.push(p))).rejects.toThrow(/Gate "starter unsolved"/);
    expect(seen).toEqual([{ gate: "reference" }, { gate: "starter" }]);
  });
});

/** A workspace whose unit exercise is installed with a fake image and the given test inventory. */
async function unitExercise(hidden = ["t"], visible = ["t"]) {
  const ws = tempDir("codemm-ws-");
  const track = readFileMap(join(fixtures, "tracks", "shell-unit"));
  store.commitFolder(store.trackDir("shell-unit@1"), track, {
    "track.json": { format_version: 1, ...parseTrackYaml(track["track.yaml"]!), image: "codemm-track-shell-unit:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
  });
  await app.saveRoadmap(ws, "units", "goal: Units\ntrack: shell-unit@1\nstyle: unit\nconcepts:\n  - { id: sh.loops, title: Loops, requires: [] }\n");
  store.commitFolder(store.exerciseDir("units", "maxof"), readFileMap(join(fixtures, "exercises", "unit-max")), {
    "exercise.json": { format_version: 1, slug: "maxof", style: "unit", concepts: ["sh.loops"], difficulty: 1, track: "shell-unit@1", createdAt: new Date().toISOString(), inventory: { visible, hidden } },
  });
  await app.getExercise(ws, "maxof");
  return ws;
}

/** A workspace whose io exercise (1 visible, 3 hidden tests) is installed with a fake image and edited. */
async function installedExercise(): Promise<string> {
  const ws = tempDir("codemm-ws-");
  const track = readFileMap(join(fixtures, "tracks", "shell-io"));
  const spec = parseTrackYaml(track["track.yaml"]!);
  store.commitFolder(store.trackDir("shell-io@1"), track, {
    "track.json": { format_version: 1, ...spec, image: "codemm-track-shell-io:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
  });
  await app.saveRoadmap(ws, "shell", readFileSync(join(fixtures, "roadmaps", "shell-io.yaml"), "utf8"));
  store.commitFolder(store.exerciseDir("shell", "max-of-line"), readFileMap(join(fixtures, "exercises", "io-max")), {
    "exercise.json": {
      format_version: 1, slug: "max-of-line", style: "io", concepts: ["sh.loops"], difficulty: 1, track: "shell-io@1",
      createdAt: new Date().toISOString(), expected: { "visible/01": "3\n", "hidden/01": "5\n", "hidden/02": "-1\n", "hidden/03": "7\n" },
    },
  });
  const { path } = await app.getExercise(ws, "max-of-line");
  writeFileSync(join(path, "main.sh"), "echo 3\n");
  return ws;
}
