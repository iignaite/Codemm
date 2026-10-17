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

  // A label gives this file's track image its own ID, so deleting it can't affect other test files.
  const appTrack = (): Record<string, string> => {
    const t = fixtureTrack("shell-io").files;
    return { ...t, Dockerfile: `${t.Dockerfile}LABEL codemm.test=app\n` };
  };

  beforeAll(() => {
    process.env.CODEMM_HOME = mkdtempSync(join(tmpdir(), "codemm-home-"));
    ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
  });

  it("installs a track once and refuses a different track under the same version", async () => {
    expect(await app.saveTrack(appTrack())).toEqual({ installed: "shell-io@1" });
    expect(await app.saveTrack(appTrack())).toEqual({ installed: "shell-io@1", unchanged: true });
    const changed = { ...appTrack(), "track.yaml": appTrack()["track.yaml"]!.replace("2000", "3000") };
    await expect(app.saveTrack(changed)).rejects.toThrow(/already installed/);
    expect(app.listTracks()).toEqual([{ track: "shell-io@1", styles: ["io"], files: ["main.sh"] }]);
  });

  it("installs a track whose base image isn't pinned by digest, with a warning", async () => {
    const t = appTrack();
    const unpinned = {
      ...t,
      "track.yaml": t["track.yaml"]!.replace("id: shell-io", "id: shell-unpinned"),
      Dockerfile: t.Dockerfile!.replace(/^FROM \S+/, "FROM codemm-track-shell-io:1"),
    };
    const r = await app.saveTrack(unpinned);
    expect(r).toMatchObject({ installed: "shell-unpinned@1" });
    expect(r.warning).toMatch(/digest: codemm-track-shell-io:1\./);
    // A child image would keep a later test from removing shell-io@1's image.
    await cli(["image", "rm", "-f", "codemm-track-shell-unpinned:1"]);
  });

  it("enforces roadmap rules", async () => {
    await expect(app.saveRoadmap(ws, "shell", roadmap("shell-io").replace("style: io", "style: unit"))).rejects.toThrow(/style/);
    expect(await app.saveRoadmap(ws, "shell", roadmap("shell-io"))).toEqual({ course: "shell", concepts: 2 });
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8"))).toMatchObject({ course: "shell" });
  });

  it("asks for a first exercise", () => {
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", concept: "sh.basics", title: "Basics", difficulty: 1, lesson: null, style: "io", track: "shell-io@1" });
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

  it("serves the exercise without hidden data", async () => {
    const view = await app.getExercise(ws);
    expect(view).toMatchObject({ exercise: "max-of-line", style: "io", files: ["main.sh"], visibleTests: [{ name: "01", input: "3 1 2\n", expected: "3\n" }] });
    expect(JSON.stringify(view)).not.toMatch(/1 5 2|-3 -1 -2/);
  });

  it("runs visible tests without recording an attempt", async () => {
    const r = await app.testExercise(ws);
    expect(r.tests.map((t) => t.status)).toEqual(["fail"]);
    expect(readEvents("shell")).toEqual([]);
  });

  it("grades a check of the unedited starter without recording it", async () => {
    const r = await app.checkExercise(ws);
    expect(r).toMatchObject({ passed: 0, total: 4, recorded: false });
    expect(r.note).toMatch(/starter/);
    expect(readEvents("shell")).toEqual([]);
  });

  it("records a failed check, then a passing one, and moves on", async () => {
    const file = join(ws, "exercises", "shell", "max-of-line", "main.sh");
    writeFileSync(file, "read line\necho 1\n");
    const failed = await app.checkExercise(ws);
    expect(failed).toMatchObject({ passed: 0, total: 4, recorded: true });
    // One real failed attempt after an unrecorded starter check isn't "stuck".
    expect(app.progress(ws).concepts[0]).toMatchObject({ id: "sh.basics", stuck: false });
    expect(failed.tests.filter((t) => t.name.startsWith("hidden"))).toEqual([
      { name: "hidden #1", status: "fail" },
      { name: "hidden #2", status: "fail" },
      { name: "hidden #3", status: "fail" },
    ]);

    writeFileSync(file, exercise("io-max")["solution/main.sh"]!);
    const passed = await app.checkExercise(ws);
    expect(passed).toMatchObject({ passed: 4, total: 4, recorded: true });
    const p = app.progress(ws);
    expect(p.concepts[0]).toMatchObject({ id: "sh.basics", difficulty: 1 });
    expect(p.concepts[0]!.mastery).toBeCloseTo(0.35 + 0.3 * (1 - 0.35), 2);
    expect(app.nextStep(ws)).toMatchObject({ kind: "author", concept: "sh.basics" });
  });

  it("recreates deleted learner files without touching edited ones", async () => {
    const dir = join(ws, "exercises", "shell", "max-of-line");
    rmSync(join(dir, "README.md"));
    await app.getExercise(ws, "max-of-line");
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(readFileSync(join(dir, "main.sh"), "utf8")).toBe(exercise("io-max")["solution/main.sh"]);
  });

  it("marks exercises assisted while assist mode is on, for good", async () => {
    await app.setAssist(ws, true);
    await app.setAssist(ws, false);
    await app.checkExercise(ws);
    const events = readEvents("shell");
    expect(events.filter((e) => e.kind === "assist")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "check", assisted: true });
  });

  it("defers a skipped concept without marking it mastered", async () => {
    await app.skip(ws, "sh.basics");
    expect(app.progress(ws).concepts[0]).toMatchObject({ mastered: false });
    await expect(app.skip(ws, "sh.nope")).rejects.toThrow(/not in/);
  });

  it("refuses roadmap changes that would orphan exercises or change the track", async () => {
    const without = `goal: Shell\ntrack: shell-io@1\nstyle: io\nconcepts:\n  - { id: sh.loops, title: Loops, requires: [] }\n`;
    await expect(app.saveRoadmap(ws, "shell", without)).rejects.toThrow(/sh\.basics/);
  });

  it("keeps the installed image when a rebuild is rejected", async () => {
    const exJson = join(process.env.CODEMM_HOME!, "courses", "shell", "exercises", "max-of-line", "exercise.json");
    const original = readFileSync(exJson, "utf8");
    writeFileSync(exJson, original.replace('"visible/01": "3\\n"', '"visible/01": "4\\n"'));
    await expect(app.rebuildTrack("shell-io@1")).rejects.toThrow(/behaves differently/);
    writeFileSync(exJson, original);
    expect((await app.checkExercise(ws)).recorded).toBe(true);
  });

  it("doesn't let a check that finishes after a course switch hijack the new course", async () => {
    const pending = app.checkExercise(ws);
    await app.saveRoadmap(ws, "shell-two", roadmap("shell-io"));
    await pending;
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8"))).toMatchObject({ course: "shell-two" });
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8")).current).toBeUndefined();
    await app.saveRoadmap(ws, "shell", roadmap("shell-io"));
  });

  it("writes learner files for an exercise with more visible tests than the author file limit allows twice over", async () => {
    const base = exercise("io-max");
    const many: Record<string, string> = { ...base, "exercise.yaml": base["exercise.yaml"]!.replace("max-of-line", "many-cases").replace("sh.loops", "sh.basics") };
    for (let i = 2; i <= 140; i++) many[`tests/visible/${String(i).padStart(3, "0")}.in`] = "3 1 2\n";
    expect(await app.saveExercise(ws, many)).toEqual({ exercise: "many-cases" });
    expect(readdirSync(join(ws, "exercises", "shell", "many-cases", "tests"))).toHaveLength(280);
  });

  it("keeps assistance evidence and selects the exercise on an unrecorded starter check", async () => {
    await app.setAssist(ws, true);
    const r = await app.checkExercise(ws, "many-cases");
    await app.setAssist(ws, false);
    expect(r.recorded).toBe(false);
    expect(readEvents("shell").filter((e) => e.kind === "check" && e.exercise === "many-cases")).toEqual([]);
    expect(readEvents("shell")).toContainEqual(expect.objectContaining({ kind: "assist", exercise: "many-cases" }));
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8")).current).toBe("many-cases");
  });

  it("records nothing when the track image is gone, and rebuild re-validates every exercise", async () => {
    const before = readEvents("shell").length;
    const id = JSON.parse(readFileSync(join(process.env.CODEMM_HOME!, "tracks", "shell-io@1", "track.json"), "utf8")).imageId;
    await cli(["image", "rm", "-f", id]);
    await expect(app.checkExercise(ws, "max-of-line")).rejects.toThrow(/track rebuild/);
    expect(readEvents("shell")).toHaveLength(before);

    expect(await app.rebuildTrack("shell-io@1")).toEqual({ rebuilt: "shell-io@1", exercises: 2 });
    expect((await app.checkExercise(ws, "max-of-line")).recorded).toBe(true);
  });

  it("installs a consented proposal, exactly once, and drops it", async () => {
    const t = appTrack();
    const files = { ...t, "track.yaml": t["track.yaml"]!.replace("id: shell-io", "id: shell-consent"), Dockerfile: `${t.Dockerfile}LABEL codemm.test=consent\n` };
    expect(await app.proposeTrack(files)).toMatchObject({ proposed: "shell-consent@1" });
    expect(app.listTracks().map((x) => x.track)).not.toContain("shell-consent@1");
    const { digest } = app.listProposals().find((p) => p.track === "shell-consent@1")!;
    expect(await app.installProposal("shell-consent@1", digest)).toEqual({ installed: "shell-consent@1" });
    expect(app.listTracks().map((x) => x.track)).toContain("shell-consent@1");
    expect(app.listProposals()).toEqual([]);
    await cli(["image", "rm", "-f", "codemm-track-shell-consent:1"]);
  });

  it("saves a bound author job's exercise to its own course, even if the learner switches mid-save", async () => {
    const files = { ...exercise("io-max"), "exercise.yaml": exercise("io-max")["exercise.yaml"]!.replace("max-of-line", "bound-save").replace("sh.loops", "sh.basics") };
    const pending = app.saveExercise(ws, files, "shell");
    await app.saveRoadmap(ws, "shell-other", roadmap("shell-io"));
    expect(await pending).toEqual({ exercise: "bound-save" });
    expect(app.listExercises(ws, "shell").map((e) => e.exercise)).toContain("bound-save");
    expect(app.listExercises(ws)).toEqual([]);
    expect(existsSync(join(ws, "exercises", "shell", "bound-save", "main.sh"))).toBe(true);
    expect(JSON.parse(readFileSync(join(ws, "codemm.json"), "utf8")).course).toBe("shell-other");
  });

  it("runs a lesson's examples in the sandbox before saving it, and runs one again on request without recording", async () => {
    const lesson = (id: string, files: Record<string, string>) => ({ id, concept: "sh.basics", title: "Echo", markdown: "Run this:\n\n```example\n1\n```\n", examples: [files] });
    await expect(app.saveLesson(ws, lesson("broken", { "main.sh": "echo oops >&2\nexit 3\n" }), "shell")).rejects.toThrow(/Example 1 didn't run cleanly \(exit 3\)[\s\S]*oops/);
    expect(await app.saveLesson(ws, lesson("echo", { "main.sh": "echo hello\n" }), "shell")).toEqual({ lesson: "echo" });
    expect(app.getLesson(ws, "echo", "shell").examples).toEqual([{ "main.sh": "echo hello\n" }]);
    const before = readEvents("shell").length;
    expect(await app.runExample(ws, "echo", 1, "shell")).toEqual({ exit: 0, output: "hello\n", errors: "" });
    await expect(app.runExample(ws, "echo", 2, "shell")).rejects.toThrow(/no example 2/);
    expect(readEvents("shell")).toHaveLength(before);
  });
});
