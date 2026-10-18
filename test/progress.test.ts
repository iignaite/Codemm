import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import type { CheckProgress } from "../src/app.js";
import { readFileMap } from "../src/files.js";
import { parseTrackYaml } from "../src/schemas.js";
import * as store from "../src/store.js";
import { fakeDocker, posix } from "./fake-docker.js";

/** Check progress: io reports each test as it finishes; hidden tests are counted, never named. */

const fixtures = join(import.meta.dirname, "fixtures");

beforeEach(() => {
  vi.stubEnv("CODEMM_HOME", mkdtempSync(join(tmpdir(), "codemm-home-")));
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

  it("records nothing when Docker fails mid-check, whatever progress was reported", async () => {
    const ws = await installedExercise();
    fakeDocker("killed");
    const seen: CheckProgress[] = [];
    await expect(app.checkExercise(ws, undefined, undefined, (p) => seen.push(p))).rejects.toThrow(/wasn't counted/);
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

  it("shows each hidden test as an index and a status only, in the result and its progress", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    const view = await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    const hidden = view.tests.filter((t) => t.name.startsWith("hidden"));
    expect(hidden.map((t) => Object.keys(t).sort())).toEqual([["name", "status"], ["name", "status"], ["name", "status"]]);
    expect(hidden.map((t) => t.name)).toEqual(["hidden #1", "hidden #2", "hidden #3"]);
    // Nothing from the hidden files: their names, inputs or expected outputs.
    const out = JSON.stringify({ view, seen });
    for (const secret of ["hidden/01", "hidden/02", "hidden/03", "-1\\n", "7\\n"]) expect(out).not.toContain(secret);
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
    expect(view.tests.filter((t) => t.name.startsWith("hidden"))).toEqual([{ name: "hidden #1", status: expect.any(String) }]);
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});

/** A workspace whose unit exercise (visible test "t", and `hidden`) is installed with a fake image. */
async function unitExercise(hidden = ["t"]) {
  const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
  const track = readFileMap(join(fixtures, "tracks", "shell-unit"));
  store.commitFolder(store.trackDir("shell-unit@1"), track, {
    "track.json": { format_version: 1, ...parseTrackYaml(track["track.yaml"]!), image: "codemm-track-shell-unit:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
  });
  await app.saveRoadmap(ws, "units", "goal: Units\ntrack: shell-unit@1\nstyle: unit\nconcepts:\n  - { id: sh.loops, title: Loops, requires: [] }\n");
  store.commitFolder(store.exerciseDir("units", "maxof"), readFileMap(join(fixtures, "exercises", "unit-max")), {
    "exercise.json": { format_version: 1, slug: "maxof", style: "unit", concepts: ["sh.loops"], difficulty: 1, track: "shell-unit@1", createdAt: new Date().toISOString(), inventory: { visible: ["t"], hidden } },
  });
  await app.getExercise(ws, "maxof");
  return ws;
}

/** A workspace whose io exercise (1 visible, 3 hidden tests) is installed with a fake image and edited. */
async function installedExercise(): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
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
