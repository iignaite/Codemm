import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { assertPortablePaths, type FileMap, subMap, validateFileMap } from "./files.js";
import { checkTrackFiles, verifyExercise, verifyTrack } from "./gates.js";
import type { TestResult, TestSet } from "./grading.js";
import { gradeIoRun, gradeUnitRun, type IoRun, runIo, runUnit, type UnitRun } from "./judge.js";
import { type LearnerEvent, MASTERED, nextStep as pickNext, replay, type Step } from "./learner.js";
import { assertRuntime, cli as sandboxCli, inspectImage } from "./sandbox.js";
import { assertNotes, type CourseRecord, type ExerciseRecord, parseLesson, parseRoadmapYaml, type TrackRecord } from "./schemas.js";
import * as store from "./store.js";

/**
 * Codemm's use cases. The CLI and the MCP server are thin wrappers around these.
 * `ws` is always an absolute workspace path. Course-scoped use cases take an optional `bound` course,
 * which replaces the workspace's active one (`codemm mcp --course`).
 */

const learnerDir = (course: string, slug: string) => `exercises/${course}/${slug}`;

function activeCourse(ws: string, bound?: string): CourseRecord {
  const course = bound ?? store.readWorkspace(ws).course;
  if (!course) throw new CodemmError("No course in this workspace yet. Ask your agent to plan a roadmap (save_roadmap).");
  const record = store.readCourse(course);
  if (!record) throw new CodemmError(`Course "${course}" is missing from ${store.codemmHome()}.`);
  return record;
}

function installedTrack(ref: string): TrackRecord {
  const track = store.readTrack(ref);
  if (!track) throw new CodemmError(`Track ${ref} is not installed. Install it first (save_track).`);
  return track;
}

/** Fails, without recording anything, when the runtime or the verified image isn't there. */
async function ensureImage(track: TrackRecord): Promise<void> {
  await assertRuntime();
  const info = await inspectImage(track.imageId);
  if (!info) {
    throw new CodemmError(`The image for ${track.id}@${track.version} is missing or changed. Run \`codemm track rebuild ${track.id}@${track.version}\`, then retry.`);
  }
}

// ---------- tracks ----------

export function listTracks() {
  return store.listTracks().map((t) => ({ track: `${t.id}@${t.version}`, styles: t.styles, files: t.files }));
}

/** Track gate 1, part one: the files are valid, with a Dockerfile and complete probes, and name an id@version. */
function readTrackSpec(files: FileMap) {
  assertPortablePaths(validateFileMap(files));
  const { spec } = checkTrackFiles(files);
  return { spec, ref: `${spec.id}@${spec.version}` };
}

/** Track gate 1, part two, under the track lock: true when these files are installed, an error when others are. */
function alreadyInstalled(ref: string, version: number, files: FileMap): boolean {
  if (!store.readTrack(ref)) return false;
  if (JSON.stringify(sorted(store.readTrackFiles(ref))) === JSON.stringify(sorted(files))) return true;
  throw new CodemmError(`${ref} is already installed with different files. Save your changes as version ${version + 1}.`);
}

/** Gates 2 to 5, then an atomic install. Call while holding the track lock. */
async function install(ref: string, files: FileMap): Promise<{ installed: string; warning?: string }> {
  const verified = await verifyTrack(files);
  const record: TrackRecord = {
    format_version: 1, ...verified.spec, image: verified.image, imageId: verified.imageId, installedAt: new Date().toISOString(),
  };
  store.commitFolder(store.trackDir(ref), files, { "track.json": record });
  return { installed: ref, ...(verified.warning ? { warning: verified.warning } : {}) };
}

export async function saveTrack(files: FileMap): Promise<{ installed: string; unchanged?: true; warning?: string }> {
  const { spec, ref } = readTrackSpec(files);
  return store.withLock(store.trackLockPath(spec.id), async () => {
    if (alreadyInstalled(ref, spec.version, files)) return { installed: ref, unchanged: true as const };
    return install(ref, files);
  });
}

const sorted = (map: FileMap) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

// ---------- setup proposals (desktop) ----------
//
// In the desktop app, save_track only proposes. The learner consents in Codemm, and installProposal
// builds exactly the files they were shown, identified by digest.

export async function proposeTrack(files: FileMap): Promise<{ installed: string; unchanged: true } | { proposed: string; note: string }> {
  const { spec, ref } = readTrackSpec(files);
  return store.withLock(store.trackLockPath(spec.id), async () => {
    if (alreadyInstalled(ref, spec.version, files)) return { installed: ref, unchanged: true as const };
    store.writeProposal(ref, files);
    return { proposed: ref, note: "The learner decides in Codemm. End your turn." };
  });
}

export function listProposals() {
  return store.listProposals().map(({ record, files }) => ({ track: record.track, digest: record.digest, created: record.created, files }));
}

/** Installs a proposal only if its files still have the digest the learner consented to. */
export async function installProposal(ref: string, digest: string): Promise<{ installed: string; unchanged?: true; warning?: string }> {
  const { id, version } = store.parseTrackRef(ref);
  return store.withLock(store.trackLockPath(id), async () => {
    const files = store.readProposal(ref, digest);
    if (!files || store.fileMapDigest(files) !== digest || readTrackSpec(files).ref !== ref) {
      throw new CodemmError(`The proposal for ${ref} changed or is gone, so it needs the learner's consent again.`);
    }
    if (alreadyInstalled(ref, version, files)) {
      store.dropProposals(ref);
      return { installed: ref, unchanged: true as const };
    }
    store.assertFreeSpace(store.codemmHome());
    const result = await install(ref, files);
    store.dropProposals(ref);
    return result;
  });
}

export async function dropProposal(ref: string): Promise<void> {
  await store.withLock(store.trackLockPath(store.parseTrackRef(ref).id), async () => store.dropProposals(ref));
}

/** Rebuilds a pruned or changed image and re-runs every gate before trusting it (DESIGN §4.4). */
export async function rebuildTrack(ref: string): Promise<{ rebuilt: string; exercises: number }> {
  const old = installedTrack(ref);
  return store.withLock(store.trackLockPath(old.id), async () => {
    // Build under a candidate tag; the installed tag and ID stay untouched unless every gate passes.
    const candidate = `${old.image}-candidate`;
    const verified = await verifyTrack(store.readTrackFiles(ref), candidate);
    const track: TrackRecord = { ...old, imageId: verified.imageId };
    const changed: string[] = [];
    let count = 0;
    for (const courseId of store.listCourses()) {
      const course = store.readCourse(courseId);
      if (!course) continue;
      for (const ex of store.listExercises(courseId).filter((e) => e.track === ref)) {
        count += 1;
        const { files } = store.readExercise(courseId, ex.slug);
        try {
          const again = await verifyExercise(track, course, files, new Set());
          if (JSON.stringify(again.expected) !== JSON.stringify(ex.expected) || JSON.stringify(again.inventory) !== JSON.stringify(ex.inventory)) {
            changed.push(`${courseId}/${ex.slug}: results changed`);
          }
        } catch (e) {
          changed.push(`${courseId}/${ex.slug}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    if (changed.length > 0) {
      await sandboxCli(["image", "rm", candidate]);
      throw new CodemmError(`The rebuilt image behaves differently, so it wasn't accepted:\n${changed.join("\n")}`);
    }
    const tagged = await sandboxCli(["tag", verified.imageId, old.image]);
    if (tagged.exit !== 0) throw new CodemmError(`Couldn't promote the rebuilt image, so nothing changed: ${tagged.output.trim().slice(0, 300)}`);
    store.writeTrackRecord(ref, track);
    // The image keeps its installed tag, so dropping the candidate tag only untags it.
    await sandboxCli(["image", "rm", candidate]);
    return { rebuilt: ref, exercises: count };
  });
}

// ---------- roadmaps ----------

const eventConcepts = (e: LearnerEvent): string[] => (e.kind === "check" ? e.concepts : "concept" in e ? [e.concept] : []);

/**
 * The track may be a draft that isn't installed yet (next_step then says "setup"), and may change until the
 * course has exercises. A stuck concept that gains a prerequisite gets a `retry` event: a fresh start.
 */
export async function saveRoadmap(ws: string, course: string, yaml: string, bound?: string): Promise<{ course: string; concepts: number }> {
  if (bound && course !== bound) throw new CodemmError(`This job saves only course "${bound}".`);
  const roadmap = parseRoadmapYaml(yaml);
  const track = store.readTrack(roadmap.track);
  if (track && !track.styles.includes(roadmap.style)) throw new CodemmError(`Track ${roadmap.track} offers ${track.styles.join(", ")}, not style "${roadmap.style}".`);
  const record: CourseRecord = { format_version: 1, course, ...roadmap };
  await store.withLock(store.courseLockPath(course), async () => {
    let retries: string[] = [];
    const existing = store.readCourse(course);
    if (existing) {
      const exercises = store.listExercises(course);
      if (existing.track !== roadmap.track && exercises.length > 0) {
        throw new CodemmError(`Course "${course}" has exercises for ${existing.track}, so it can't switch tracks. Start a new course instead.`);
      }
      const events = store.readEvents(course);
      const kept = new Set(roadmap.concepts.map((c) => c.id));
      const used = new Set([
        ...exercises.flatMap((e) => e.concepts),
        ...events.flatMap(eventConcepts),
        ...store.listLessons(course).map((l) => l.concept),
      ]);
      const removed = [...used].filter((c) => !kept.has(c));
      if (removed.length > 0) throw new CodemmError(`These concepts have exercises, lessons or progress and can't be removed: ${removed.join(", ")}.`);
      const states = replay(events);
      const before = new Map(existing.concepts.map((c) => [c.id, c.requires]));
      retries = roadmap.concepts.filter((c) => {
        const old = before.get(c.id);
        return old && states.get(c.id)?.stuck && c.requires.some((r) => !old.includes(r));
      }).map((c) => c.id);
    }
    // The roadmap goes first: if appending fails, the concept stays stuck rather than restarting without its prerequisite.
    store.writeCourse(record);
    for (const concept of retries) store.appendEvent(course, { format_version: 1, kind: "retry", at: new Date().toISOString(), concept });
  });
  await store.updateWorkspace(ws, (config) => ({ ...config, course, current: config.course === course ? config.current : undefined }));
  return { course, concepts: roadmap.concepts.length };
}

export function getRoadmap(ws: string, bound?: string) {
  const { course, goal, track, style, concepts } = activeCourse(ws, bound);
  return { course, goal, track, style, concepts };
}

// ---------- lessons ----------

/** Saves static Markdown for one roadmap concept. Nothing in a lesson runs, and its text never changes. */
export async function saveLesson(ws: string, input: unknown, bound?: string): Promise<{ lesson: string }> {
  const lesson = parseLesson(input);
  const courseId = activeCourse(ws, bound).course;
  await store.withLock(store.courseLockPath(courseId), async () => {
    const course = store.readCourse(courseId)!;
    if (!course.concepts.some((c) => c.id === lesson.concept)) throw new CodemmError(`"${lesson.concept}" is not in the roadmap for ${courseId}.`);
    if (store.listLessons(courseId).some((l) => l.id === lesson.id)) throw new CodemmError(`Lesson id "${lesson.id}" is already used in ${courseId}. Pick a new id.`);
    const { markdown, ...meta } = lesson;
    store.writeLesson(courseId, { format_version: 1, ...meta, created: new Date().toISOString() }, markdown);
  });
  return { lesson: lesson.id };
}

/** The lesson and the learner's notes. Reading records nothing: only markLessonRead does. */
export function getLesson(ws: string, id: string, bound?: string) {
  const { record, markdown, notes } = store.readLesson(activeCourse(ws, bound).course, id);
  return { id: record.id, concept: record.concept, title: record.title, markdown, notes };
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

// ---------- exercises ----------

export type NextStep = Step | { kind: "setup"; track: string } | (Extract<Step, { kind: "author" }> & { style: string; track: string });

const pickFor = (course: CourseRecord) =>
  pickNext(course, store.listExercises(course.course), store.readEvents(course.course), store.listLessons(course.course));

export function nextStep(ws: string, bound?: string): NextStep {
  const course = activeCourse(ws, bound);
  const track = store.readTrack(course.track);
  if (!track) return { kind: "setup", track: course.track };
  if (!track.styles.includes(course.style)) {
    throw new CodemmError(`Track ${course.track} offers ${track.styles.join(", ")}, not style "${course.style}". Edit the roadmap's style.`);
  }
  const step = pickFor(course);
  return step.kind === "author" ? { ...step, style: course.style, track: course.track } : step;
}

export async function saveExercise(ws: string, files: FileMap, bound?: string): Promise<{ exercise: string; warning?: string }> {
  assertPortablePaths(validateFileMap(files));
  const courseId = activeCourse(ws, bound).course;
  const { record, track } = await store.withLock(store.courseLockPath(courseId), () => {
    // Re-read under the course lock, then lock that course's current track: a draft's track can change.
    const course = store.readCourse(courseId)!;
    return store.withLock(store.trackLockPath(store.parseTrackRef(course.track).id), async () => {
      const track = installedTrack(course.track);
      await ensureImage(track);
      const taken = new Set(store.listExercises(courseId).map((e) => e.slug));
      const verified = await verifyExercise(track, course, files, taken);
      store.commitFolder(store.exerciseDir(courseId, verified.slug), files, { "exercise.json": verified });
      return { record: verified, track };
    });
  });
  try {
    store.materialize(ws, learnerDir(courseId, record.slug), learnerFiles(record, files, track));
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

/** What the learner may see: the statement, starter files and visible tests (with expected io outputs). */
function learnerFiles(record: ExerciseRecord, files: FileMap, track: TrackRecord): FileMap {
  const out: FileMap = { "README.md": files["README.md"] ?? "" };
  for (const f of track.files) out[f] = files[`starter/${f}`] ?? "";
  for (const [p, v] of Object.entries(subMap(files, "tests/visible"))) out[`tests/${p}`] = v;
  if (record.style === "io") {
    for (const [name, expected] of Object.entries(record.expected ?? {})) {
      if (name.startsWith("visible/")) out[`tests/${name.slice("visible/".length)}.out`] = expected;
    }
  }
  return out;
}

function loadExercise(ws: string, slug?: string, bound?: string) {
  const course = activeCourse(ws, bound);
  const config = store.readWorkspace(ws);
  const preferred = slug ?? (config.course === course.course ? config.current : undefined);
  const next = preferred ? undefined : pickFor(course);
  const chosen = preferred ?? (next?.kind === "practice" ? next.exercise : undefined);
  if (!chosen) throw new CodemmError("No exercise to practice yet. Ask your agent for the next step (next_step).");
  const { record, files } = store.readExercise(course.course, chosen);
  const track = installedTrack(record.track);
  return { course, config, record, files, track, rel: learnerDir(course.course, record.slug) };
}

/** Appends an assist event if the exercise has none. Call only while holding the course lock. */
function noteAssistLocked(course: string, slug: string): void {
  if (!store.readEvents(course).some((e) => e.kind === "assist" && e.exercise === slug)) {
    store.appendEvent(course, { format_version: 1, kind: "assist", at: new Date().toISOString(), exercise: slug });
  }
}

export async function getExercise(ws: string, slug?: string, bound?: string) {
  const { course, config, record, files, track, rel } = loadExercise(ws, slug, bound);
  store.materialize(ws, rel, learnerFiles(record, files, track));
  // Record assistance before the exercise becomes current, so edits are never allowed without the evidence.
  if (config.assist) await store.withLock(store.courseLockPath(course.course), async () => noteAssistLocked(course.course, record.slug));
  await store.updateWorkspace(ws, (c) => (c.course === course.course ? { ...c, current: record.slug } : c));
  const visible = subMap(files, "tests/visible");
  return {
    course: course.course,
    exercise: record.slug,
    path: join(ws, rel),
    style: record.style,
    concepts: record.concepts,
    difficulty: record.difficulty,
    files: track.files,
    statement: files["README.md"] ?? "",
    ...(record.hint ? { hint: record.hint } : {}),
    visibleTests:
      record.style === "io"
        ? Object.keys(visible).sort().map((p) => {
            const name = p.slice(0, -3);
            return { name, input: visible[p]!, expected: record.expected?.[`visible/${name}`] ?? "" };
          })
        : Object.keys(visible).sort().map((name) => ({ name })),
  };
}

/** The learner's editable files for an exercise, each with the digest a later save must name. */
export function readLearnerFiles(ws: string, slug: string, bound?: string): Record<string, { text: string; digest: string }> {
  const { record, files, track, rel } = loadExercise(ws, slug, bound);
  store.materialize(ws, rel, learnerFiles(record, files, track));
  const src = store.readLearnerFiles(ws, rel, track.files);
  return Object.fromEntries(Object.entries(src).map(([path, text]) => [path, { text, digest: store.digestText(text) }]));
}

/** Saves one learner file, refusing it if the file changed since the editor loaded `digest`. */
export async function writeLearnerFile(ws: string, slug: string, path: string, text: string, digest: string, bound?: string): Promise<{ digest: string }> {
  const { track, rel } = loadExercise(ws, slug, bound);
  if (!track.files.includes(path)) throw new CodemmError(`"${path}" isn't one of this exercise's files (${track.files.join(", ")}).`);
  validateFileMap({ [path]: text });
  return store.withWorkspaceLock(ws, async () => ({ digest: store.replaceLearnerFile(ws, rel, path, text, digest) }));
}

export type CheckView = {
  exercise: string;
  passed: number;
  total: number;
  tests: (Pick<TestResult, "name" | "status"> & Partial<Pick<TestResult, "message" | "actual">>)[];
  recorded: boolean;
  note?: string;
};

/** Visible results in full; hidden results reduced to an index and a status (DESIGN §4.2). */
function present(slug: string, tests: TestResult[], recorded: boolean, note?: string): CheckView {
  let hidden = 0;
  return {
    exercise: slug,
    passed: tests.filter((t) => t.status === "pass").length,
    total: tests.length,
    recorded,
    ...(note ? { note } : {}),
    tests: tests.map((t) => {
      if (t.set === "hidden") return { name: `hidden #${(hidden += 1)}`, status: t.status };
      return { name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}), ...(t.actual !== undefined && t.status !== "pass" ? { actual: t.actual } : {}) };
    }),
  };
}

async function judge(ws: string, slug: string | undefined, includeHidden: boolean, bound?: string) {
  const ctx = loadExercise(ws, slug, bound);
  const { record, files, rel } = ctx;
  await ensureImage(ctx.track);
  const track = { ...ctx.track, image: ctx.track.imageId };
  store.materialize(ws, rel, learnerFiles(record, files, track));
  const src = store.readLearnerFiles(ws, rel, track.files);
  const sets: TestSet[] = includeHidden ? ["visible", "hidden"] : ["visible"];
  const tests: TestResult[] = [];
  for (const set of sets) {
    const t = subMap(files, `tests/${set}`);
    if (record.style === "io") {
      const run: IoRun = await runIo(track, set, src, t);
      const expected = Object.fromEntries(Object.entries(record.expected ?? {}).filter(([k]) => k.startsWith(`${set}/`)));
      tests.push(...gradeIoRun(run, expected));
    } else {
      const run: UnitRun = await runUnit(track, src, t);
      tests.push(...gradeUnitRun(set, run, record.inventory?.[set]));
    }
  }
  return { ...ctx, src, tests };
}

/** Runs the visible tests only. Never recorded. */
export async function testExercise(ws: string, slug?: string, bound?: string): Promise<CheckView> {
  const { record, tests } = await judge(ws, slug, false, bound);
  return present(record.slug, tests, false);
}

/**
 * Runs every test and records the attempt. Infrastructure failures throw before anything is recorded.
 * A check of the unedited starter is graded but records no check event: it isn't an attempt (DESIGN §7).
 */
export async function checkExercise(ws: string, slug?: string, bound?: string): Promise<CheckView> {
  const { course, config, record, files, track, src, tests } = await judge(ws, slug, true, bound);
  const unedited = track.files.every((f) => src[f] === files[`starter/${f}`]);
  const passed = tests.filter((t) => t.status === "pass").length;
  await store.withLock(store.courseLockPath(course.course), async () => {
    if (config.assist) noteAssistLocked(course.course, record.slug);
    if (unedited) return;
    const assisted = config.assist || store.readEvents(course.course).some((e) => e.kind === "assist" && e.exercise === record.slug);
    store.appendEvent(course.course, {
      format_version: 1, kind: "check", at: new Date().toISOString(), exercise: record.slug,
      concepts: record.concepts, difficulty: record.difficulty, passed, total: tests.length, assisted,
    });
  });
  // Only move "current" if the workspace still points at the course that was checked.
  await store.updateWorkspace(ws, (c) => (c.course === course.course ? { ...c, current: record.slug } : c));
  return unedited ? present(record.slug, tests, false, "unedited starter, not recorded") : present(record.slug, tests, true);
}

// ---------- progress ----------

export function progress(ws: string, bound?: string) {
  const course = activeCourse(ws, bound);
  const states = replay(store.readEvents(course.course));
  return {
    course: course.course,
    goal: course.goal,
    track: course.track,
    concepts: course.concepts.map((c) => {
      const s = states.get(c.id);
      const mastery = s?.mastery ?? 0.5;
      return {
        id: c.id, title: c.title, requires: c.requires, mastery: Math.round(mastery * 1000) / 1000,
        mastered: mastery >= MASTERED, difficulty: s?.difficulty ?? 1, attempts: s?.attempts ?? 0, stuck: s?.stuck ?? false,
      };
    }),
    next: nextStep(ws, bound),
  };
}

export async function skip(ws: string, concept: string, bound?: string): Promise<void> {
  const courseId = activeCourse(ws, bound).course;
  await store.withLock(store.courseLockPath(courseId), async () => {
    const course = store.readCourse(courseId)!;
    if (!course.concepts.some((c) => c.id === concept)) throw new CodemmError(`"${concept}" is not in the roadmap for ${courseId}.`);
    store.appendEvent(courseId, { format_version: 1, kind: "skip", at: new Date().toISOString(), concept });
  });
}

export async function setAssist(ws: string, on: boolean): Promise<void> {
  // Turning assistance on records the evidence first, then grants the permission.
  const { course, current } = store.readWorkspace(ws);
  if (on && course && current) await store.withLock(store.courseLockPath(course), async () => noteAssistLocked(course, current));
  await store.updateWorkspace(ws, (c) => ({ ...c, assist: on }));
}

export { assertRuntime };
