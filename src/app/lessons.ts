import { CodemmError } from "../errors.js";
import { assertPortablePaths, type FileMap, subMap, validateFileMap } from "../files.js";
import { runIo, runUnit } from "../judge.js";
import { type ProgramOptions, type ProgramRun, runProgram } from "../program.js";
import { assertNotes, parseLesson, type TrackRecord } from "../schemas.js";
import * as store from "../store.js";
import { activeCourse, ensureImage, installedTrack } from "./shared.js";

// ---------- lessons ----------

/** An example holds exactly the track's learner files, plus tests/ files for unit. Checked before anything runs. */
function assertExampleFits(n: number, files: FileMap, track: TrackRecord, style: string): void {
  assertPortablePaths(validateFileMap(files));
  const learner = Object.keys(files).filter((p) => !(style === "unit" && p.startsWith("tests/")));
  const fits = learner.length === track.files.length && track.files.every((f) => f in files);
  if (!fits || (style === "unit" && learner.length === Object.keys(files).length)) {
    const tests = style === "unit" ? ", and its tests under tests/" : "";
    throw new CodemmError(`Example ${n} must hold exactly the track's learner files (${track.files.join(", ")})${tests}.`);
  }
}

export type ExampleRun = { exit: number; output: string; errors: string };
const cap = (text: string, bytes: number) => (Buffer.byteLength(text) > bytes ? `${Buffer.from(text).subarray(0, bytes).toString("utf8")}\n…` : text);

/**
 * Runs one example in the track's image, exactly as a check runs code (the same sandbox and limits): io runs the
 * run command once with empty input, unit runs the test command on the example's tests/. `clean` is a zero exit.
 */
async function runOne(track: TrackRecord, style: string, files: FileMap): Promise<ExampleRun & { clean: boolean }> {
  const t = { ...track, image: track.imageId };
  const learner = Object.fromEntries(track.files.map((f) => [f, files[f]!]));
  if (style === "io") {
    const run = await runIo(t, "visible", learner, { "01.in": "" });
    if (run.flooded) return { exit: -1, output: "", errors: "Printed more than 4 MB.", clean: false };
    if (run.outOfMemory) return { exit: -1, output: "", errors: "Ran out of memory.", clean: false };
    if (run.build && run.build.exit !== 0) return { exit: run.build.exit, output: "", errors: run.build.output, clean: false };
    const c = run.cases[0];
    if (!c) return { exit: -1, output: "", errors: "It didn't run.", clean: false };
    if (c.big) return { exit: c.exit, output: "", errors: "Printed more than 64 KB.", clean: false };
    return { exit: c.exit, output: c.stdout, errors: c.stderr, clean: c.exit === 0 };
  }
  const run = await runUnit(t, learner, subMap(files, "tests"));
  if (run.flooded) return { exit: -1, output: "", errors: "Printed more than 4 MB.", clean: false };
  if (run.outOfMemory) return { exit: -1, output: "", errors: "Ran out of memory.", clean: false };
  return { exit: run.report.exit, output: run.report.body, errors: run.report.log, clean: run.report.exit === 0 };
}

/**
 * Saves a lesson for one roadmap concept: static Markdown, and optional examples that must run cleanly in the
 * track's sandbox first. The text never changes. A lesson without examples doesn't need the track.
 */
export async function saveLesson(ws: string, input: unknown, bound?: string): Promise<{ lesson: string }> {
  const lesson = parseLesson(input);
  const examples = lesson.examples ?? [];
  const courseId = activeCourse(ws, bound).course;
  const save = async () => {
    const course = store.readCourse(courseId)!;
    if (!course.concepts.some((c) => c.id === lesson.concept)) throw new CodemmError(`"${lesson.concept}" is not in the roadmap for ${courseId}.`);
    if (store.listLessons(courseId).some((l) => l.id === lesson.id)) throw new CodemmError(`Lesson id "${lesson.id}" is already used in ${courseId}. Pick a new id.`);
    if (examples.length > 0) {
      const track = store.readTrack(course.track);
      if (!track) throw new CodemmError(`Examples run in ${course.track}, which isn't set up yet. Save the lesson without examples.`);
      examples.forEach((files, i) => assertExampleFits(i + 1, files, track, course.style));
      await ensureImage(track);
      for (const [i, files] of examples.entries()) {
        const run = await runOne(track, course.style, files);
        if (!run.clean) throw new CodemmError(`Example ${i + 1} didn't run cleanly (exit ${run.exit}):\n${cap(run.errors || run.output, 2000)}`);
      }
    }
    const { markdown, examples: _, ...meta } = lesson;
    const checked = examples.length ? { examples: examples.length, track: course.track, style: course.style } : {};
    store.writeLesson(courseId, { format_version: 1, ...meta, created: new Date().toISOString(), ...checked }, markdown, examples);
  };
  // Examples run on the track's image, so hold its lock too (course, then track, as saveExercise does).
  await store.withLock(store.courseLockPath(courseId), async () => {
    const track = store.readCourse(courseId)!.track;
    return examples.length > 0 ? store.withLock(store.trackLockPath(store.parseTrackRef(track).id), save) : save();
  });
  return { lesson: lesson.id };
}

/**
 * Runs a saved io example live in the sandbox, with the learner's typed input and the track it was checked with:
 * the same interactive run as Run on an activity. Never recorded. A unit example runs as tests (runExample).
 */
export async function runExampleLive(
  ws: string, lessonId: string, index: number, bound: string | undefined, output: (text: string, stream: "stdout" | "stderr") => void, options: ProgramOptions = {},
): Promise<ProgramRun> {
  const { record, examples } = store.readLesson(activeCourse(ws, bound).course, lessonId);
  const files = Number.isInteger(index) ? examples[index - 1] : undefined;
  if (!files || !record.track || !record.style) throw new CodemmError(`Lesson "${lessonId}" has no example ${index}.`);
  if (record.style !== "io") throw new CodemmError(`Example ${index} runs as tests, so it has no live run.`);
  const track = installedTrack(record.track);
  assertExampleFits(index, files, track, record.style);
  await ensureImage(track);
  const learner = Object.fromEntries(track.files.map((f) => [f, files[f]!]));
  return runProgram({ ...track, image: track.imageId }, learner, output, options);
}

/** Runs a saved example in the sandbox, with the track and style it was checked with, for the learner to see. Never recorded. */
export async function runExample(ws: string, lessonId: string, index: number, bound?: string): Promise<ExampleRun> {
  const { record, examples } = store.readLesson(activeCourse(ws, bound).course, lessonId);
  const files = Number.isInteger(index) ? examples[index - 1] : undefined;
  if (!files || !record.track || !record.style) throw new CodemmError(`Lesson "${lessonId}" has no example ${index}.`);
  const track = installedTrack(record.track);
  assertExampleFits(index, files, track, record.style);
  await ensureImage(track);
  const { exit, output, errors } = await runOne(track, record.style, files);
  return { exit, output: cap(output, 16_384), errors: cap(errors, 4096) };
}

/** The lesson and the learner's notes. Reading records nothing: only markLessonRead does. */
export function getLesson(ws: string, id: string, bound?: string) {
  const { record, markdown, notes, examples } = store.readLesson(activeCourse(ws, bound).course, id);
  // The style says how its examples run: io ones take typed input (runExampleLive), unit ones run as tests.
  return { id: record.id, concept: record.concept, title: record.title, markdown, notes, examples, ...(record.style ? { style: record.style } : {}) };
}

/**
 * The texts no output may show: an exercise's solution, mutants, hidden tests and hidden expected outputs. Only for
 * the desktop's reply filter, which holds back an agent reply that quotes them (desktop DESIGN §2.2).
 */
export function hiddenMaterial(course: string, slug: string): string[] {
  const { record, files } = store.readExercise(course, slug);
  return [
    ...Object.entries(files).filter(([path]) => /^(solution|mutants|tests\/hidden)\//.test(path)).map(([, text]) => text),
    ...Object.entries(record.expected ?? {}).filter(([name]) => name.startsWith("hidden/")).map(([, text]) => text),
  ];
}

export function listLessons(ws: string, bound?: string) {
  const course = activeCourse(ws, bound).course;
  const read = new Set(store.readEvents(course).flatMap((e) => (e.kind === "read" ? [e.lesson] : [])));
  return store.listLessons(course).map((l) => ({ id: l.id, concept: l.concept, title: l.title, created: l.created, read: read.has(l.id) }));
}

export async function saveNotes(ws: string, id: string, text: string, bound?: string): Promise<void> {
  assertNotes(text);
  const course = activeCourse(ws, bound).course;
  await store.withLock(store.courseLockPath(course), async () => {
    store.readLesson(course, id);
    store.writeNotes(course, id, text);
  });
}

/** The learner's acknowledgement that they read a lesson. Recorded once. */
export async function markLessonRead(ws: string, id: string, bound?: string): Promise<void> {
  const course = activeCourse(ws, bound).course;
  await store.withLock(store.courseLockPath(course), async () => {
    const { record } = store.readLesson(course, id);
    if (store.readEvents(course).some((e) => e.kind === "read" && e.lesson === id)) return;
    store.appendEvent(course, { format_version: 1, kind: "read", at: new Date().toISOString(), lesson: id, concept: record.concept });
  });
}
