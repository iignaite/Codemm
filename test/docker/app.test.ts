import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as app from "../../src/app.js";
import { readFileMap } from "../../src/files.js";
import { cli } from "../../src/sandbox.js";
import { readEvents } from "../../src/store.js";
import { dockerUp, FIXTURES, fixtureTrack } from "./helpers.js";

const roadmap = (name: string) => readFileSync(join(FIXTURES, "roadmaps", `${name}.yaml`), "utf8");
const exercise = (name: string) => readFileMap(join(FIXTURES, "exercises", name));

describe.runIf(dockerUp)("app (Docker, end to end)", () => {
  let ws: string;

  beforeAll(() => {
    process.env.CODEMM_HOME = mkdtempSync(join(tmpdir(), "codemm-home-"));
    ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
  });

  it("installs a track once and refuses a different track under the same version", async () => {
    expect(await app.saveTrack(fixtureTrack("shell-io").files)).toEqual({ installed: "shell-io@1" });
    expect(await app.saveTrack(fixtureTrack("shell-io").files)).toEqual({ installed: "shell-io@1", unchanged: true });
    const changed = { ...fixtureTrack("shell-io").files, "track.yaml": fixtureTrack("shell-io").files["track.yaml"]!.replace("2000", "3000") };
    await expect(app.saveTrack(changed)).rejects.toThrow(/already installed/);
    expect(app.listTracks()).toEqual([{ track: "shell-io@1", styles: ["io"], files: ["main.sh"] }]);
  });

  it("enforces roadmap rules", async () => {
    await expect(app.saveRoadmap(ws, "shell", roadmap("shell-io").replace("shell-io@1", "rust@1"))).rejects.toThrow(/not installed/);
    await expect(app.saveRoadmap(ws, "shell", roadmap("shell-io").replace("style: io", "style: unit"))).rejects.toThrow(/style/);
    expect(await app.saveRoadmap(ws, "shell", roadmap("shell-io"))).toEqual({ course: "shell", concepts: 2 });
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8"))).toMatchObject({ course: "shell" });
  });

  it("asks for a first exercise", () => {
    expect(app.nextStep(ws)).toEqual({ kind: "author", concept: "sh.basics", difficulty: 1, style: "io", track: "shell-io@1" });
  });

  it("saves an exercise and writes only learner-side files to the workspace", async () => {
    const files = { ...exercise("io-max"), "exercise.yaml": exercise("io-max")["exercise.yaml"]!.replace("sh.loops", "sh.basics") };
    expect(await app.saveExercise(ws, files)).toEqual({ exercise: "max-of-line" });
    const dir = join(ws, "exercises", "shell", "max-of-line");
    expect(readdirSync(dir).sort()).toEqual(["README.md", "main.sh", "tests"]);
    expect(readdirSync(join(dir, "tests")).sort()).toEqual(["01.in", "01.out"]);
    expect(readFileSync(join(dir, "tests", "01.out"), "utf8")).toBe("3\n");
    await expect(app.saveExercise(ws, files)).rejects.toThrow(/already used/);
  });

  it("serves the exercise without hidden data", () => {
    const view = app.getExercise(ws);
    expect(view).toMatchObject({ exercise: "max-of-line", style: "io", files: ["main.sh"], visibleTests: [{ name: "01", input: "3 1 2\n", expected: "3\n" }] });
    expect(JSON.stringify(view)).not.toMatch(/1 5 2|-3 -1 -2/);
  });

  it("runs visible tests without recording an attempt", async () => {
    const r = await app.testExercise(ws);
    expect(r.tests.map((t) => t.status)).toEqual(["fail"]);
    expect(readEvents("shell")).toEqual([]);
  });

  it("records a failed check, then a passing one, and moves on", async () => {
    const failed = await app.checkExercise(ws);
    expect(failed).toMatchObject({ passed: 0, total: 4, recorded: true });
    expect(failed.tests.filter((t) => t.name.startsWith("hidden"))).toEqual([
      { name: "hidden #1", status: "fail" },
      { name: "hidden #2", status: "fail" },
      { name: "hidden #3", status: "fail" },
    ]);

    writeFileSync(join(ws, "exercises", "shell", "max-of-line", "main.sh"), exercise("io-max")["solution/main.sh"]!);
    const passed = await app.checkExercise(ws);
    expect(passed).toMatchObject({ passed: 4, total: 4, recorded: true });
    const p = app.progress(ws);
    expect(p.concepts[0]).toMatchObject({ id: "sh.basics", difficulty: 1 });
    expect(p.concepts[0]!.mastery).toBeCloseTo(0.35 + 0.3 * (1 - 0.35), 2);
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", concept: "sh.basics" });
  });

  it("recreates deleted learner files without touching edited ones", () => {
    const dir = join(ws, "exercises", "shell", "max-of-line");
    rmSync(join(dir, "README.md"));
    app.getExercise(ws, "max-of-line");
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(readFileSync(join(dir, "main.sh"), "utf8")).toBe(exercise("io-max")["solution/main.sh"]);
  });

  it("marks exercises assisted while assist mode is on, for good", async () => {
    app.setAssist(ws, true);
    app.setAssist(ws, false);
    await app.checkExercise(ws);
    const events = readEvents("shell");
    expect(events.filter((e) => e.kind === "assist")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "check", assisted: true });
  });

  it("skips a concept", () => {
    app.skip(ws, "sh.basics");
    expect(app.progress(ws).concepts[0]).toMatchObject({ mastered: true });
    expect(() => app.skip(ws, "sh.nope")).toThrow(/not in/);
  });

  it("refuses roadmap changes that would orphan exercises or change the track", async () => {
    const without = `goal: Shell\ntrack: shell-io@1\nstyle: io\nconcepts:\n  - { id: sh.loops, title: Loops, requires: [] }\n`;
    await expect(app.saveRoadmap(ws, "shell", without)).rejects.toThrow(/sh\.basics/);
  });

  it("records nothing when the track image is gone, and rebuild re-validates every exercise", async () => {
    const before = readEvents("shell").length;
    await cli(["image", "rm", "-f", "codemm-track-shell-io:1"]);
    await expect(app.checkExercise(ws)).rejects.toThrow(/track rebuild/);
    expect(readEvents("shell")).toHaveLength(before);

    expect(await app.rebuildTrack("shell-io@1")).toEqual({ rebuilt: "shell-io@1", exercises: 1 });
    expect((await app.checkExercise(ws)).recorded).toBe(true);
  });
});
