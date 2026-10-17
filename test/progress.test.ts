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
  it("reports the build, then each io test as it finishes, visible then hidden, while the container is still running", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: (CheckProgress & { at: number })[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push({ ...p, at: Date.now() }));
    expect(seen.map(({ phase, done, total }) => [phase, done, total])).toEqual([
      ["building", 0, 0],
      ["visible", 0, 1],
      ["visible", 1, 1],
      ["hidden", 0, 3],
      ["hidden", 1, 3],
      ["hidden", 2, 3],
      ["hidden", 3, 3],
    ]);
    // Streamed, not reported all at once when the container exits: the fake waits 0.2 s between tests.
    const hidden = seen.filter((p) => p.phase === "hidden" && p.done > 0);
    expect(hidden[2]!.at - hidden[0]!.at).toBeGreaterThanOrEqual(300);
  });

  it("carries only a phase and counts: no test names, inputs or output", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    for (const p of seen) expect(Object.keys(p).sort()).toEqual(["done", "phase", "total"]);
  });

  it("reports the visible tests only for Try it", async () => {
    const ws = await installedExercise();
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.testExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(seen.map((p) => p.phase)).toEqual(["building", "visible", "visible"]);
  });
});

describe.runIf(posix)("check progress for unit exercises", () => {
  it("reports each phase once, with no count, because the runner reports at the end", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
    const track = readFileMap(join(fixtures, "tracks", "shell-unit"));
    store.commitFolder(store.trackDir("shell-unit@1"), track, {
      "track.json": { format_version: 1, ...parseTrackYaml(track["track.yaml"]!), image: "codemm-track-shell-unit:1", imageId: "sha256:fake", installedAt: new Date().toISOString() },
    });
    await app.saveRoadmap(ws, "units", "goal: Units\ntrack: shell-unit@1\nstyle: unit\nconcepts:\n  - { id: sh.loops, title: Loops, requires: [] }\n");
    store.commitFolder(store.exerciseDir("units", "maxof"), readFileMap(join(fixtures, "exercises", "unit-max")), {
      "exercise.json": { format_version: 1, slug: "maxof", style: "unit", concepts: ["sh.loops"], difficulty: 1, track: "shell-unit@1", createdAt: new Date().toISOString(), inventory: { visible: ["t"], hidden: ["t"] } },
    });
    await app.getExercise(ws, "maxof");
    fakeDocker("streams");
    const seen: CheckProgress[] = [];
    await app.checkExercise(ws, undefined, undefined, (p) => seen.push(p));
    expect(seen).toEqual([
      { phase: "visible", done: 0, total: 0 },
      { phase: "hidden", done: 0, total: 0 },
    ]);
  });
});

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
