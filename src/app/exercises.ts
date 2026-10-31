import { stringify } from "yaml";
import { join } from "node:path";
import { CodemmError } from "../errors.js";
import { assertPortablePaths, type FileMap, subMap, validateFileMap } from "../files.js";
import { type ExerciseGate, verifyQuiz, verifyExercise } from "../gates.js";
import { type CaseFrames, expectedText, gradeIo, gradeQuiz, redact, type ShownResult, type Status, type TestResult, type TestSet } from "../grading.js";
import { judgeSets } from "../judge.js";
import { type ProgramOptions, type ProgramRun, runProgram } from "../program.js";
import { lastCheck, nextLesson, nextStep as pickNext, type LessonStep, type Step } from "../learner.js";
import { parseQuizYaml, parseAnswersYaml, type CourseRecord, type ExerciseRecord, type TrackRecord } from "../schemas.js";
import * as store from "../store.js";
import { activeCourse, ensureImage, installedTrack, learnerDir, noteAssistLocked, quietly, trackContract } from "./shared.js";

// ---------- exercises ----------

/**
 * What a fresh author needs from the installed track, and nothing hidden: the learner files, the commands that
 * build, run or test them for this style, the limits, and the track's own probe as a worked example.
 */
export type TrackContract = {
  /** "wasi": the WASI engine, where exercises have no input generators (DESIGN §4.5). */
  engine: "docker" | "wasi";
  files: string[];
  build?: string;
  run?: string;
  test?: string;
  limits: { time_ms: number; memory_mb: number };
  examples: { solution: FileMap; tests: FileMap };
};

export type NextStep =
  | Step
  | LessonStep
  | { kind: "setup"; track: string }
  | (Extract<Step, { kind: "author" }> & { title: string; practice?: string; pitfalls?: string[]; style: string; track?: string; contract?: TrackContract; earlier: Earlier[] } & LearnerContext);

/**
 * What the author adapts the task to: the concept's lessons as the learner reads them, and their last check on the
 * concept, including what they missed. Hidden tests stay indexes only, as the tutor already sees in check.
 */
export type LearnerContext = { lessonText?: string; last?: ReturnType<typeof lastCheck> };

/** At most this many bytes of lesson text, so next_step stays small enough for an agent to take in whole. */
const LESSON_TEXT_BYTES = 32_768;

/** The concept's lessons, newest first (a re-teach matters most), cut to LESSON_TEXT_BYTES at a character. */
function lessonText(course: string, concept: string): string {
  const text = store.listLessons(course).filter((l) => l.concept === concept).reverse().map((l) => store.readLessonText(course, l.id)).join("\n\n");
  const bytes = Buffer.from(text);
  return bytes.length <= LESSON_TEXT_BYTES ? text : bytes.subarray(0, LESSON_TEXT_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
}

function learnerContext(course: string, concept: string): LearnerContext {
  const text = lessonText(course, concept);
  const last = lastCheck(store.readEvents(course), concept);
  return { ...(text ? { lessonText: text } : {}), ...(last ? { last } : {}) };
}

/** An exercise the course already has, as its statement shows it, so the next one can be a different task. */
export type Earlier = { title: string; summary: string };

/** Each exercise's statement title (its first heading) and first line of prose. Never its solution or tests. */
function earlierExercises(course: string): Earlier[] {
  return store.listExercises(course).map((e) => {
    const lines = (store.readExercise(course, e.slug).files["README.md"] ?? "").split("\n").map((l) => l.trim());
    const heading = lines.find((l) => l.startsWith("#"));
    const prose = lines.find((l) => l !== "" && !l.startsWith("#")) ?? "";
    return { title: heading ? heading.replace(/^#+\s*/, "") : e.slug, summary: prose.length > 200 ? `${prose.slice(0, 199)}…` : prose };
  });
}

const pickFor = (course: CourseRecord) => {
  const events = store.readEvents(course.course);
  const checked = new Set(events.flatMap((e) => e.kind === "check" ? [e.exercise] : []));
  const exercises = store.listExercises(course.course).filter((e) => e.style !== "quiz" || !checked.has(e.slug));
  return pickNext(course, exercises, events, store.listLessons(course.course), new Date().toISOString());
};

export function nextStep(ws: string, bound?: string): NextStep {
  const course = activeCourse(ws, bound);
  if (course.style === "none") return nextLesson(course, store.readEvents(course.course), store.listLessons(course.course));
  let contract: { track: string; contract: TrackContract } | undefined;
  if (course.style !== "quiz") {
    const track = store.readTrack(course.track);
    if (!track) return { kind: "setup", track: course.track };
    if (!track.styles.includes(course.style)) {
      throw new CodemmError(`Track ${course.track} offers ${track.styles.join(", ")}, not style "${course.style}". Edit the roadmap's style.`);
    }
    contract = { track: course.track, contract: trackContract(track, course.style) };
  }
  const step = pickFor(course);
  if (step.kind !== "author") return step;
  // The step's concept comes from this roadmap. JSON leaves out practice and pitfalls when a concept has none.
  const { title, practice, pitfalls } = course.concepts.find((c) => c.id === step.concept)!;
  return { ...step, title, practice, pitfalls, style: course.style, ...contract, earlier: earlierExercises(course.course), ...learnerContext(course.course, step.concept) };
}

/** Writes each exercise gate as it starts to a job's progress file (`codemm mcp --progress`), by name only. */
export const gateProgressTo = (path: string) => ({ gate }: { gate: ExerciseGate }) => store.writeJobProgress(path, gate);

/** `onProgress` hears which gate runs, by name only (DESIGN §6). */
export async function saveExercise(ws: string, files: FileMap, bound?: string, onProgress?: (p: { gate: ExerciseGate }) => void): Promise<{ exercise: string; warning?: string }> {
  const onGate = quietly(onProgress);
  assertPortablePaths(validateFileMap(files));
  const courseId = activeCourse(ws, bound).course;
  const saved = await store.withLock(store.courseLockPath(courseId), async (): Promise<{ record: ExerciseRecord; files: FileMap; track?: TrackRecord }> => {
    // Re-read under the course lock, then lock that course's current track: a draft's track can change.
    const course = store.readCourse(courseId)!;
    assertActivities(course);
    if (course.style === "quiz") {
      const existing = store.listExercises(courseId);
      const verified = verifyQuiz(course, files, new Set(existing.map((e) => e.slug)),
        existing.filter((e) => e.style === "quiz").map((e) => store.readExercise(courseId, e.slug).files["quiz.yaml"]!));
      store.commitFolder(store.exerciseDir(courseId, verified.record.slug), verified.files, { "exercise.json": verified.record });
      return { ...verified, track: undefined };
    }
    return store.withLock(store.trackLockPath(store.parseTrackRef(course.track).id), async () => {
      const track = installedTrack(course.track);
      await ensureImage(track);
      const existing = store.listExercises(courseId);
      const taken = new Set(existing.map((e) => e.slug));
      // Earlier exercises on this track have the same learner files, so their solutions can run against the new tests.
      const earlier = existing
        .filter((e) => e.style !== "quiz").filter((e) => e.track === course.track)
        .map((e) => ({ slug: e.slug, style: e.style, concepts: e.concepts, createdAt: e.createdAt, solution: subMap(store.readExercise(courseId, e.slug).files, "solution") }));
      const verified = await verifyExercise(track, course, files, taken, onGate && ((gate) => onGate({ gate })), earlier);
      store.commitFolder(store.exerciseDir(courseId, verified.slug), files, { "exercise.json": verified });
      return { record: verified, files, track };
    });
  });
  const { record, track } = saved;
  try {
    store.materialize(ws, learnerDir(courseId, record.slug), learnerFiles(record, saved.files, track?.files ?? ["answers.yaml"]));
  } catch (e) {
    // The exercise is saved; get_exercise retries writing the learner files.
    return { exercise: record.slug, warning: `Saved, but the learner files couldn't be written yet: ${(e as Error).message}` };
  }
  return { exercise: record.slug };
}

/** Saved exercises, oldest first. A job's done check reads `created`. */
export function listExercises(ws: string, bound?: string) {
  return store.listExercises(activeCourse(ws, bound).course).map((e) => ({ exercise: e.slug, concepts: e.concepts, difficulty: e.difficulty, created: e.createdAt }));
}

/**
 * What the learner may see: the statement, starter files and visible tests (with expected io outputs). A long expected
 * output is recorded only as its digest and start, so it gets no .out file.
 */
function learnerFiles(record: ExerciseRecord, files: FileMap, editable: string[]): FileMap {
  const out: FileMap = { "README.md": files["README.md"] ?? "" };
  if (record.style === "quiz") return { ...out, "answers.yaml": stringify(Object.fromEntries(parseQuizYaml(files["quiz.yaml"]!).questions.map((_, i) => [i + 1, null]))) };
  for (const f of editable) out[f] = files[`starter/${f}`] ?? "";
  for (const [p, v] of Object.entries(subMap(files, "tests/visible"))) out[`tests/${p}`] = v;
  if (record.style === "io") {
    for (const [name, expected] of Object.entries(record.expected ?? {})) {
      if (name.startsWith("visible/") && typeof expected === "string") out[`tests/${name.slice("visible/".length)}.out`] = expected;
    }
  }
  return out;
}

/** An io test's input file: `NN.in`, or `NN.gen`, a script whose output is the input (DESIGN §6). */
const ioInput = /\.(in|gen)$/;

function assertActivities(course: CourseRecord): asserts course is Exclude<CourseRecord, { style: "none" }> {
  if (course.style === "none") throw new CodemmError("This course has lessons only. Turn activities on to practise.");
}

function loadExercise(ws: string, slug?: string, bound?: string) {
  const course = activeCourse(ws, bound);
  assertActivities(course);
  const config = store.readWorkspace(ws);
  const preferred = slug ?? (config.course === course.course ? config.current : undefined);
  const next = preferred ? undefined : pickFor(course);
  const chosen = preferred ?? (next?.kind === "practice" ? next.exercise : undefined);
  if (!chosen) throw new CodemmError("No exercise to practice yet. Ask your agent for the next step (next_step).");
  const { record, files } = store.readExercise(course.course, chosen);
  const context = { course, config, record, files, rel: learnerDir(course.course, record.slug) };
  if (record.style === "quiz") return { ...context, style: "quiz" as const, track: undefined, editable: ["answers.yaml"] };
  const track = installedTrack(record.track);
  return { ...context, style: record.style, track, editable: track.files };
}

export async function getExercise(ws: string, slug?: string, bound?: string) {
  const { course, record, files, track, editable, rel } = loadExercise(ws, slug, bound);
  store.materialize(ws, rel, learnerFiles(record, files, editable));
  // Record assistance before the exercise becomes current, so edits are never allowed without the evidence. Both
  // happen under the workspace lock, reading assistance as it is then, so a concurrent setAssist can't be missed.
  await store.updateWorkspace(ws, async (c) => {
    if (c.assist) await store.withLock(store.courseLockPath(course.course), async () => noteAssistLocked(course.course, record.slug));
    return c.course === course.course ? { ...c, current: record.slug } : c;
  });
  const visible = subMap(files, "tests/visible");
  return {
    course: course.course,
    exercise: record.slug,
    path: join(ws, rel),
    style: record.style,
    concepts: record.concepts,
    difficulty: record.difficulty,
    files: editable,
    ...(record.style === "quiz" ? { questions: parseQuizYaml(files["quiz.yaml"]!).questions.map((q) => ({ text: q.text, choices: q.choices.map((c) => ({ text: c.text })) })) } : {}),
    ...(record.style === "io" && track?.run ? { run: track.run } : {}),
    statement: files["README.md"] ?? "",
    ...(record.hint ? { hint: record.hint } : {}),
    // A generated input shows its generator; a long expected output shows its start, and says so.
    visibleTests:
      record.style === "io"
        ? Object.keys(visible).filter((p) => ioInput.test(p)).sort().map((p) => {
            const name = p.replace(ioInput, "");
            const expected = record.expected?.[`visible/${name}`] ?? "";
            return {
              name, input: visible[p]!, ...(p.endsWith(".gen") ? { generated: true } : {}), expected: expectedText(expected),
              ...(typeof expected === "string" ? {} : { expectedBytes: expected.bytes }),
            };
          })
        : Object.keys(visible).sort().map((name) => ({ name })),
  };
}

/** The learner's editable files for an exercise, each with the digest a later save must name. */
export function readLearnerFiles(ws: string, slug: string, bound?: string): Record<string, { text: string; digest: string }> {
  const { record, files, editable, rel } = loadExercise(ws, slug, bound);
  store.materialize(ws, rel, learnerFiles(record, files, editable));
  const src = store.readLearnerFiles(ws, rel, editable);
  return Object.fromEntries(Object.entries(src).map(([path, text]) => [path, { text, digest: store.digestText(text) }]));
}

/** Saves one learner file, refusing it if the file changed since the editor loaded `digest`. */
export async function writeLearnerFile(ws: string, slug: string, path: string, text: string, digest: string, bound?: string): Promise<{ digest: string }> {
  const { editable, rel } = loadExercise(ws, slug, bound);
  if (!editable.includes(path)) throw new CodemmError(`"${path}" isn't one of this exercise's files (${editable.join(", ")}).`);
  validateFileMap({ [path]: text });
  return store.withWorkspaceLock(ws, async () => ({ digest: store.replaceLearnerFile(ws, rel, path, text, digest) }));
}

export type CheckView = {
  exercise: string;
  passed: number;
  total: number;
  /** Visible tests in full; hidden ones as `hidden #N`, with `index` N, and a status only. */
  tests: ShownResult[];
  recorded: boolean;
  note?: string;
};

/** Visible results in full; hidden results reduced to an index and a status (DESIGN §4.2). */
function present(slug: string, tests: TestResult[], recorded: boolean, note?: string): CheckView {
  return {
    exercise: slug,
    passed: tests.filter((t) => t.status === "pass").length,
    total: tests.length,
    recorded,
    ...(note ? { note } : {}),
    tests: redact(tests),
  };
}

/**
 * Progress through a check. io reports each visible test as it finishes, with its result; hidden tests, and unit
 * tests (whose runner reports at the end), report their phase once with `total` 0. Nothing about a hidden test
 * leaves (DESIGN §4.2).
 */
/** A visible test's result as it finishes: what Results shows for it. Hidden tests never have one. */
export type VisibleTestResult = { name: string; status: Status; message?: string; actual?: string };
export type CheckProgress = { phase: "building" | "visible" | "hidden"; done: number; total: number; test?: VisibleTestResult };

async function judge(ws: string, ctx: ReturnType<typeof loadExercise>, includeHidden: boolean, listener?: (p: CheckProgress) => void) {
  // A listener that throws is dropped; the check goes on.
  let heard = listener;
  const onProgress = heard && ((p: CheckProgress) => {
    try {
      heard?.(p);
    } catch {
      heard = undefined;
    }
  });
  const { record, files, rel } = ctx;
  if (ctx.style === "quiz") throw new CodemmError("A quiz has no practice run. Check it when you're ready.");
  await ensureImage(ctx.track);
  const track = store.judgeTrack(ctx.track);
  store.materialize(ws, rel, learnerFiles(record, files, ctx.editable));
  const src = store.readLearnerFiles(ws, rel, track.files);
  const visible = subMap(files, "tests/visible");
  const sets = includeHidden ? { visible, hidden: subMap(files, "tests/hidden") } : { visible };
  // Each visible io test's result as it finishes, graded as Results grades it. The final grade still decides:
  // a flood or a memory kill afterwards makes every test an error.
  const total = Object.keys(visible).filter((p) => ioInput.test(p)).length;
  const report = (done: number) => onProgress?.({ phase: "visible", done: Math.min(done, total), total });
  let finished = 0;
  const onCase = (c: CaseFrames) => {
    const name = `visible/${c.name}`;
    const expected = record.expected?.[name];
    if (expected === undefined) return;
    const [r] = gradeIo([{ ...c, name }], { [name]: expected });
    finished += 1;
    const test = { name, status: r!.status, ...(r!.message ? { message: r!.message } : {}), ...(r!.actual !== undefined ? { actual: r!.actual } : {}) };
    onProgress?.({ phase: "visible", done: Math.min(finished, total), total, test });
  };
  const onSet = (set: TestSet) => {
    // unit runners report at the end, and hidden tests report their phase only: per-test timing could hint at
    // what a hidden input does.
    if (record.style !== "io" || set === "hidden") return void onProgress?.({ phase: set, done: 0, total: 0 });
    // The build runs in each set's container; it shows once, before the visible tests.
    if (track.build) onProgress?.({ phase: "building", done: 0, total: 0 });
    else report(0);
    return onProgress && { onProgress: (m: "built" | number) => report(m === "built" ? 0 : m), onCase };
  };
  const tests = await judgeSets(track, ctx.style, src, sets, { expected: record.expected, inventory: record.inventory }, { onSet });
  return { ...ctx, src, tests };
}

/**
 * Run: the learner's program, interactively, in the sandbox, with typed stdin and live output. io tracks only.
 * Never recorded; infrastructure failures reject `done`.
 */
export async function runInteractive(ws: string, slug: string | undefined, bound: string | undefined, output: (text: string, stream: "stdout" | "stderr") => void, limits: ProgramOptions = {}): Promise<ProgramRun> {
  const ctx = loadExercise(ws, slug, bound);
  if (ctx.style === "quiz") throw new CodemmError("A quiz has no program to run.");
  if (!ctx.track.run) throw new CodemmError("This track has no run command, so Run isn't available.");
  await ensureImage(ctx.track);
  store.materialize(ws, ctx.rel, learnerFiles(ctx.record, ctx.files, ctx.editable));
  const src = store.readLearnerFiles(ws, ctx.rel, ctx.track.files);
  return runProgram(store.judgeTrack(ctx.track), src, output, limits);
}

/** Runs the visible tests only. Never recorded. */
export async function testExercise(ws: string, slug?: string, bound?: string, onProgress?: (p: CheckProgress) => void): Promise<CheckView> {
  const { record, tests } = await judge(ws, loadExercise(ws, slug, bound), false, onProgress);
  return present(record.slug, tests, false);
}

/**
 * Runs every test and records the attempt. Infrastructure failures throw before anything is recorded.
 * A check of the unedited starter is graded but records no check event: it isn't an attempt (DESIGN §7).
 */
export async function checkExercise(ws: string, slug?: string, bound?: string, onProgress?: (p: CheckProgress) => void): Promise<CheckView> {
  const ctx = loadExercise(ws, slug, bound);
  if (ctx.style === "quiz") return checkQuiz(ws, ctx);
  const { course, config, record, files, track, src, tests } = await judge(ws, ctx, true, onProgress);
  const unedited = track.files.every((f) => src[f] === files[`starter/${f}`]);
  const view = present(record.slug, tests, !unedited, unedited ? "unedited starter, not recorded" : undefined);
  const missed = view.tests.filter((t) => t.status !== "pass");
  // Only move "current" if the workspace still points at the course that was checked. This write can fail (a full
  // disk), so it goes first and the attempt is recorded last: a failed workspace update never leaves a counted attempt.
  await store.updateWorkspace(ws, (c) => (c.course === course.course ? { ...c, current: record.slug } : c));
  await store.withLock(store.courseLockPath(course.course), async () => {
    if (config.assist) noteAssistLocked(course.course, record.slug);
    if (unedited) return;
    const assisted = config.assist || store.readEvents(course.course).some((e) => e.kind === "assist" && e.exercise === record.slug);
    store.appendEvent(course.course, {
      format_version: 1, kind: "check", at: new Date().toISOString(), exercise: record.slug,
      concepts: record.concepts, difficulty: record.difficulty, passed: view.passed, total: view.total, assisted,
      ...(missed.length ? { missed: {
        visible: missed.filter((t) => t.index === undefined).map((t) => t.name).slice(0, 50),
        hidden: missed.flatMap((t) => t.index === undefined ? [] : [t.index]).slice(0, 50),
      } } : {}),
    });
  });
  return view;
}

/** Only a fully answered quiz is graded, and only its first check is recorded, decided under the course lock. */
async function checkQuiz(ws: string, { course, config, record, files, rel }: ReturnType<typeof loadExercise>): Promise<CheckView> {
  store.materialize(ws, rel, learnerFiles(record, files, ["answers.yaml"]));
  const quiz = parseQuizYaml(files["quiz.yaml"]!);
  const answers = parseAnswersYaml(store.readLearnerFiles(ws, rel, ["answers.yaml"])["answers.yaml"]!, quiz);
  // Grading one answer at a time would reveal the key before the recorded check, as Test would.
  if (Object.values(answers).some((a) => a === null)) throw new CodemmError("Answer every question, then check.");
  const view = present(record.slug, gradeQuiz(quiz, answers), false);
  await store.updateWorkspace(ws, (c) => c.course === course.course ? { ...c, current: record.slug } : c);
  await store.withLock(store.courseLockPath(course.course), async () => {
    if (config.assist) noteAssistLocked(course.course, record.slug);
    const events = store.readEvents(course.course);
    if (events.some((e) => e.kind === "check" && e.exercise === record.slug)) { view.note = "This quiz already has a recorded check."; return; }
    const missed = view.tests.filter((t) => t.status !== "pass").map((t) => t.name);
    store.appendEvent(course.course, {
      format_version: 1, kind: "check", at: new Date().toISOString(), exercise: record.slug,
      concepts: record.concepts, difficulty: record.difficulty, passed: view.passed, total: view.total,
      assisted: config.assist || events.some((e) => e.kind === "assist" && e.exercise === record.slug),
      ...(missed.length ? { missed: { visible: missed, hidden: [] } } : {}),
    });
    view.recorded = true;
  });
  return view;
}
