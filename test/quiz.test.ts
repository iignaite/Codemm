import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as app from "../src/app.js";
import * as store from "../src/store.js";
import { parseTrackYaml } from "../src/schemas.js";
import { quizFiles, quizQuestions, quizRoadmap } from "./quiz-fixture.js";
import { tempDir } from "./temp.js";

let ws: string;
beforeEach(() => { vi.stubEnv("CODEMM_HOME", tempDir()); ws = tempDir(); });
afterEach(() => vi.unstubAllEnvs());
const setup = () => app.saveRoadmap(ws, "quiz", quizRoadmap);
const saved = async (slug = "first") => { await app.saveExercise(ws, quizFiles(slug)); return app.getExercise(ws, slug); };
const key = (slug = "first", right = false) => Object.fromEntries(parse(store.readExercise("quiz", slug).files["quiz.yaml"]!).questions.map((q: ReturnType<typeof quizQuestions>[number], i: number) => [i + 1, q.choices.findIndex((c) => Boolean(c.correct) === right) + 1]));
const answer = async (answers: Record<string, number | null>, slug = "first") => {
  const file = app.readLearnerFiles(ws, slug)["answers.yaml"]!;
  await app.writeLearnerFile(ws, slug, "answers.yaml", JSON.stringify(answers), file.digest);
};

it("saves a trackless quiz course and authors with no contract or setup", async () => {
  await setup();
  expect(store.readCourse("quiz")).not.toHaveProperty("track");
  expect(app.nextStep(ws)).toMatchObject({ kind: "author", style: "quiz", concept: "a" });
  expect(app.nextStep(ws)).not.toHaveProperty("contract");
  expect(() => parseTrackYaml("id: x\nversion: 1\nstyles: [quiz]\nfiles: [a]\nrun: x")).toThrow();
  await expect(app.saveRoadmap(ws, "bad", quizRoadmap.replace('"style":"quiz"', '"style":"quiz","track":"x@1"'))).rejects.toThrow();
});

it("materializes only the statement and null answers; reads keep the stored order and never show the key", async () => {
  await setup();
  const ex = await saved();
  expect(ex.files).toEqual(["answers.yaml"]);
  expect(parse(readFileSync(join(ex.path, "answers.yaml"), "utf8"))).toEqual({ 1: null, 2: null, 3: null, 4: null, 5: null });
  expect(existsSync(join(ex.path, "quiz.yaml"))).toBe(false);
  const text = JSON.stringify(ex);
  expect(text).not.toMatch(/correct|why|No stopping rule|Loses feedback/);
  expect(ex.questions).toHaveLength(5);
  expect((await app.getExercise(ws, "first")).questions).toEqual(ex.questions);
  const stored = parse(store.readExercise("quiz", "first").files["quiz.yaml"]!).questions;
  expect(ex.questions).toEqual(stored.map((q: ReturnType<typeof quizQuestions>[number]) => ({ text: q.text, choices: q.choices.map((c) => ({ text: c.text })) })));
  await expect(app.writeLearnerFile(ws, "first", "quiz.yaml", "x", "x")).rejects.toThrow(/isn't one/);
});

it.each([
  ["too few questions", (q: ReturnType<typeof quizQuestions>) => q.slice(0, 4)],
  ["too many questions", (q: ReturnType<typeof quizQuestions>) => [...q, ...q, q[0]]],
  ["too few choices", (q: ReturnType<typeof quizQuestions>) => { q[0].choices.pop(); return q; }],
  ["too many choices", (q: ReturnType<typeof quizQuestions>) => { q[0].choices.push(...["Fourth", "Fifth", "Sixth"].map((text) => ({ text, why: "A mistake" }))); return q; }],
  ["no correct choice", (q: ReturnType<typeof quizQuestions>) => { delete q[0].choices[0].correct; q[0].choices[0].why = "A mistake"; return q; }],
  ["two correct choices", (q: ReturnType<typeof quizQuestions>) => { q[0].choices[1].correct = true; return q; }],
  ["missing why", (q: ReturnType<typeof quizQuestions>) => { delete q[0].choices[1].why; return q; }],
  ["blank why", (q: ReturnType<typeof quizQuestions>) => { q[0].choices[1].why = '  '; return q; }],
  ["duplicate choice", (q: ReturnType<typeof quizQuestions>) => { q[0].choices[1].text = ' BOUND   the work '; return q; }],
])("rejects %s without exposing private text or committing", async (_, change) => {
  await setup();
  await expect(app.saveExercise(ws, quizFiles("first", change(quizQuestions())))).rejects.toThrow();
  expect(store.listExercises("quiz")).toEqual([]);
});

it("rejects invalid files, unknown concepts, used slugs and earlier questions", async () => {
  await setup();
  const files = quizFiles();
  for (const bad of [
    { ...files, "quiz.yaml": "questions: [CANARY-SECRET" },
    { ...files, "quiz.yaml": '{"CANARY-SECRET": true}' },
    { ...files, "README.md": "" },
    { ...files, "exercise.yaml": files["exercise.yaml"].replace('"a"', '"unknown"') },
    { ...files, "extra": "x" },
    { ...files, "exercise.yaml": files["exercise.yaml"].replace('"quiz"', '"io"') },
  ]) {
    const error = await app.saveExercise(ws, bad).catch((e: Error) => e.message);
    expect(typeof error).toBe("string");
    expect(error).not.toContain("CANARY-SECRET");
  }
  await saved();
  await expect(app.saveExercise(ws, files)).rejects.toThrow(/slug/);
  const repeated = quizQuestions("first");
  repeated[0]!.text = " FIRST   situation 1? ";
  await expect(app.saveExercise(ws, quizFiles("second", repeated))).rejects.toThrow(/earlier quiz/);
});

it("refuses a check until every question is answered, records only the first complete check, and refuses Test and Run", async () => {
  await setup(); await saved();
  // Grading one answer at a time would reveal the key before the recorded check.
  await expect(app.checkExercise(ws)).rejects.toThrow("Answer every question, then check.");
  await answer({ 1: key("first", true)[1]! });
  await expect(app.checkExercise(ws)).rejects.toThrow("Answer every question, then check.");
  expect(store.readEvents("quiz")).toEqual([]);
  await answer(key());
  const first = await app.checkExercise(ws);
  expect(first).toMatchObject({ passed: 0, total: 5, recorded: true });
  expect(first.tests.every((t) => t.status === "fail" && Boolean(t.message))).toBe(true);
  expect(store.readEvents("quiz")[0]).toMatchObject({ missed: { visible: ["1", "2", "3", "4", "5"], hidden: [] } });
  await answer(key("first", true));
  expect(await app.checkExercise(ws)).toMatchObject({ passed: 5, total: 5, recorded: false });
  expect(store.readEvents("quiz")).toHaveLength(1);
  await expect(app.testExercise(ws)).rejects.toThrow("A quiz has no practice run. Check it when you're ready.");
  await expect(app.runInteractive(ws, undefined, undefined, () => {})).rejects.toThrow(/quiz/i);
});

it("records one concurrent check and progresses to a new quiz, then stuck after two failed quizzes", async () => {
  await setup(); await saved(); await answer(key());
  const results = await Promise.all([app.checkExercise(ws), app.checkExercise(ws)]);
  expect(results.filter((r) => r.recorded)).toHaveLength(1);
  expect(app.nextStep(ws)).toMatchObject({ kind: "author", difficulty: 1, style: "quiz" });
  await saved("second"); await answer(key("second"), "second");
  await app.checkExercise(ws, "second");
  expect(app.nextStep(ws)).toEqual({ kind: "stuck", concept: "a" });
});

it("rejects invalid answer numbers without recording", async () => {
  await setup(); await saved();
  for (const answers of [{ 1: 0 }, { 1: 4 }, { 6: 1 }, { 1: 1.5 }] as Record<string, number>[]) {
    await answer(answers);
    await expect(app.checkExercise(ws)).rejects.toThrow(/answers.yaml/);
  }
  expect(store.readEvents("quiz")).toEqual([]);
});

it("a recorded perfect quiz moves mastery like a code check and cannot switch to a track", async () => {
  await setup(); await saved(); await answer(key("first", true));
  await app.checkExercise(ws);
  expect(app.progress(ws).concepts[0]).toMatchObject({ mastery: 0.65, attempts: 1 });
  await app.saveRoadmap(ws, "quiz", quizRoadmap.replace('"quiz"', '"none"'));
  await setup();
  await expect(app.saveRoadmap(ws, "quiz", quizRoadmap.replace('"quiz"', '"io","track":"x@1"'))).rejects.toThrow(/switch tracks/);
});


it("shuffles deterministically once, recovers missing learner files and uses only the course lock for saving", async () => {
  await setup();
  const lock = vi.spyOn(store, "withLock");
  try {
    const ex = await saved();
    expect(lock.mock.calls.map(([path]) => path)).toEqual([store.courseLockPath("quiz")]);
    const stored = store.readExercise("quiz", "first").files["quiz.yaml"]!;
    expect(parse(stored).questions.map((q: ReturnType<typeof quizQuestions>[number]) => q.choices)).not.toEqual(quizQuestions().map((q) => q.choices));
    await app.saveRoadmap(ws, "other", quizRoadmap);
    await app.saveExercise(ws, quizFiles());
    expect(store.readExercise("other", "first").files["quiz.yaml"]).toBe(stored);
    rmSync(join(ex.path, "answers.yaml"));
    await app.getExercise(ws, "first", "quiz");
    expect(parse(readFileSync(join(ex.path, "answers.yaml"), "utf8"))[1]).toBeNull();
  } finally { lock.mockRestore(); }
});
