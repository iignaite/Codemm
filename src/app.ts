import { join } from "node:path";
import { CodemmError } from "./errors.js";
import { type FileMap, subMap, validateFileMap } from "./files.js";
import { verifyExercise, verifyTrack } from "./gates.js";
import type { TestResult, TestSet } from "./grading.js";
import { gradeIoRun, gradeUnitRun, type IoRun, runIo, runUnit, type UnitRun } from "./judge.js";
import { MASTERED, nextStep as pickNext, replay, type Step } from "./learner.js";
import { assertRuntime, inspectImage } from "./sandbox.js";
import { type CourseRecord, type ExerciseRecord, parseRoadmapYaml, parseTrackYaml, type TrackRecord } from "./schemas.js";
import * as store from "./store.js";

/**
 * Codemm's use cases. The CLI and the MCP server are thin wrappers around these.
 * `ws` is always an absolute workspace path.
 */

const learnerDir = (course: string, slug: string) => `exercises/${course}/${slug}`;

function activeCourse(ws: string): CourseRecord {
  const { course } = store.readWorkspace(ws);
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
  const info = await inspectImage(track.image);
  if (!info || info.id !== track.imageId) {
    throw new CodemmError(`The image for ${track.id}@${track.version} is missing or changed. Run \`codemm track rebuild ${track.id}@${track.version}\`, then retry.`);
  }
}

// ---------- tracks ----------

export function listTracks() {
  return store.listTracks().map((t) => ({ track: `${t.id}@${t.version}`, styles: t.styles, files: t.files }));
}

export async function saveTrack(files: FileMap): Promise<{ installed: string; unchanged?: true }> {
  validateFileMap(files);
  if (!files["track.yaml"]) throw new CodemmError("A track needs a track.yaml file.");
  const spec = parseTrackYaml(files["track.yaml"]);
  const ref = `${spec.id}@${spec.version}`;
  return store.withLock(store.trackLockPath(spec.id), async () => {
    if (store.readTrack(ref)) {
      if (JSON.stringify(sorted(store.readTrackFiles(ref))) === JSON.stringify(sorted(files))) return { installed: ref, unchanged: true };
      throw new CodemmError(`${ref} is already installed with different files. Save your changes as version ${spec.version + 1}.`);
    }
    const verified = await verifyTrack(files);
    const record: TrackRecord = {
      format_version: 1, ...verified.spec, image: verified.image, imageId: verified.imageId, installedAt: new Date().toISOString(),
    };
    store.commitFolder(store.trackDir(ref), files, { "track.json": record });
    return { installed: ref };
  });
}

const sorted = (map: FileMap) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

/** Rebuilds a pruned or changed image and re-runs every gate before trusting it (DESIGN §4.4). */
export async function rebuildTrack(ref: string): Promise<{ rebuilt: string; exercises: number }> {
  const old = installedTrack(ref);
  return store.withLock(store.trackLockPath(old.id), async () => {
    const verified = await verifyTrack(store.readTrackFiles(ref));
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
    if (changed.length > 0) throw new CodemmError(`The rebuilt image behaves differently, so it wasn't accepted:\n${changed.join("\n")}`);
    store.writeTrackRecord(ref, track);
    return { rebuilt: ref, exercises: count };
  });
}

// ---------- roadmaps ----------

export async function saveRoadmap(ws: string, course: string, yaml: string): Promise<{ course: string; concepts: number }> {
  const roadmap = parseRoadmapYaml(yaml);
  const track = installedTrack(roadmap.track);
  if (!track.styles.includes(roadmap.style)) throw new CodemmError(`Track ${roadmap.track} offers ${track.styles.join(", ")}, not style "${roadmap.style}".`);
  const record: CourseRecord = { format_version: 1, course, ...roadmap };
  await store.withLock(store.courseLockPath(course), async () => {
    const existing = store.readCourse(course);
    if (existing) {
      if (existing.track !== roadmap.track) throw new CodemmError(`Course "${course}" uses ${existing.track}; a course can't switch tracks. Start a new course instead.`);
      const kept = new Set(roadmap.concepts.map((c) => c.id));
      const used = new Set([
        ...store.listExercises(course).flatMap((e) => e.concepts),
        ...store.readEvents(course).flatMap((e) => (e.kind === "check" ? e.concepts : e.kind === "skip" ? [e.concept] : [])),
      ]);
      const removed = [...used].filter((c) => !kept.has(c));
      if (removed.length > 0) throw new CodemmError(`These concepts have exercises or progress and can't be removed: ${removed.join(", ")}.`);
    }
    store.writeCourse(record);
  });
  const config = store.readWorkspace(ws);
  store.writeWorkspace(ws, { ...config, course, ...(config.course === course && config.current ? { current: config.current } : { current: undefined }) });
  return { course, concepts: roadmap.concepts.length };
}

// ---------- exercises ----------

export type NextStep = Step | (Extract<Step, { kind: "author" }> & { style: string; track: string });

export function nextStep(ws: string): NextStep {
  const course = activeCourse(ws);
  const step = pickNext(course, store.listExercises(course.course), store.readEvents(course.course));
  return step.kind === "author" ? { ...step, style: course.style, track: course.track } : step;
}

export async function saveExercise(ws: string, files: FileMap): Promise<{ exercise: string }> {
  const course = activeCourse(ws);
  const track = installedTrack(course.track);
  const record = await store.withLock(store.courseLockPath(course.course), () =>
    store.withLock(store.trackLockPath(track.id), async () => {
      await ensureImage(track);
      const taken = new Set(store.listExercises(course.course).map((e) => e.slug));
      const verified = await verifyExercise(track, course, files, taken);
      store.commitFolder(store.exerciseDir(course.course, verified.slug), files, { "exercise.json": verified });
      return verified;
    }),
  );
  store.materialize(ws, learnerDir(course.course, record.slug), learnerFiles(record, files, track));
  return { exercise: record.slug };
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

function loadExercise(ws: string, slug?: string) {
  const course = activeCourse(ws);
  const config = store.readWorkspace(ws);
  const preferred = slug ?? config.current;
  const next = preferred ? undefined : pickNext(course, store.listExercises(course.course), store.readEvents(course.course));
  const chosen = preferred ?? (next?.kind === "practice" ? next.exercise : undefined);
  if (!chosen) throw new CodemmError("No exercise to practice yet. Ask your agent for the next step (next_step).");
  const { record, files } = store.readExercise(course.course, chosen);
  const track = installedTrack(record.track);
  return { course, config, record, files, track, rel: learnerDir(course.course, record.slug) };
}

function noteAssist(course: string, slug: string): void {
  if (!store.readEvents(course).some((e) => e.kind === "assist" && e.exercise === slug)) {
    store.appendEvent(course, { format_version: 1, kind: "assist", at: new Date().toISOString(), exercise: slug });
  }
}

export function getExercise(ws: string, slug?: string) {
  const { course, config, record, files, track, rel } = loadExercise(ws, slug);
  store.materialize(ws, rel, learnerFiles(record, files, track));
  store.writeWorkspace(ws, { ...config, current: record.slug });
  if (config.assist) noteAssist(course.course, record.slug);
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

export type CheckView = {
  exercise: string;
  passed: number;
  total: number;
  tests: (Pick<TestResult, "name" | "status"> & Partial<Pick<TestResult, "message" | "actual">>)[];
  recorded: boolean;
};

/** Visible results in full; hidden results reduced to an index and a status (DESIGN §4.2). */
function present(slug: string, tests: TestResult[], recorded: boolean): CheckView {
  let hidden = 0;
  return {
    exercise: slug,
    passed: tests.filter((t) => t.status === "pass").length,
    total: tests.length,
    recorded,
    tests: tests.map((t) => {
      if (t.set === "hidden") return { name: `hidden #${(hidden += 1)}`, status: t.status };
      return { name: t.name, status: t.status, ...(t.message ? { message: t.message } : {}), ...(t.actual !== undefined && t.status !== "pass" ? { actual: t.actual } : {}) };
    }),
  };
}

async function judge(ws: string, slug: string | undefined, includeHidden: boolean) {
  const ctx = loadExercise(ws, slug);
  const { record, files, track, rel } = ctx;
  await ensureImage(track);
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
  return { ...ctx, tests };
}

/** Runs the visible tests only. Never recorded. */
export async function testExercise(ws: string, slug?: string): Promise<CheckView> {
  const { record, tests } = await judge(ws, slug, false);
  return present(record.slug, tests, false);
}

/** Runs every test and records the attempt. Infrastructure failures throw before anything is recorded. */
export async function checkExercise(ws: string, slug?: string): Promise<CheckView> {
  const { course, config, record, tests } = await judge(ws, slug, true);
  const passed = tests.filter((t) => t.status === "pass").length;
  await store.withLock(store.courseLockPath(course.course), async () => {
    if (config.assist) noteAssist(course.course, record.slug);
    const assisted = config.assist || store.readEvents(course.course).some((e) => e.kind === "assist" && e.exercise === record.slug);
    store.appendEvent(course.course, {
      format_version: 1, kind: "check", at: new Date().toISOString(), exercise: record.slug,
      concepts: record.concepts, difficulty: record.difficulty, passed, total: tests.length, assisted,
    });
  });
  store.writeWorkspace(ws, { ...store.readWorkspace(ws), current: record.slug });
  return present(record.slug, tests, true);
}

// ---------- progress ----------

export function progress(ws: string) {
  const course = activeCourse(ws);
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
    next: nextStep(ws),
  };
}

export function skip(ws: string, concept: string): void {
  const course = activeCourse(ws);
  if (!course.concepts.some((c) => c.id === concept)) throw new CodemmError(`"${concept}" is not in the roadmap for ${course.course}.`);
  store.appendEvent(course.course, { format_version: 1, kind: "skip", at: new Date().toISOString(), concept });
}

export function setAssist(ws: string, on: boolean): void {
  const config = store.readWorkspace(ws);
  store.writeWorkspace(ws, { ...config, assist: on });
  if (on && config.course && config.current) noteAssist(config.course, config.current);
}

export { assertRuntime };
