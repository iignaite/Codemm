import { CodemmError } from "../errors.js";
import { type LearnerEvent, replay } from "../learner.js";
import { type CourseRecord, parseRoadmapYaml } from "../schemas.js";
import * as store from "../store.js";
import { activeCourse, trackContract } from "./shared.js";

// ---------- roadmaps ----------

const eventConcepts = (e: LearnerEvent): string[] => (e.kind === "check" ? e.concepts : "concept" in e ? [e.concept] : []);

/**
 * The track may be a draft that isn't installed yet (next_step then says "setup"), and may change until the
 * course has exercises. A stuck concept that gains a prerequisite gets a `retry` event: a fresh start.
 */
/** Saving makes the course active in `ws`, unless `activate` is false: the app re-saving one of the learner's courses mustn't replace a new course's draft. */
export async function saveRoadmap(ws: string, course: string, yaml: string, bound?: string, activate = true): Promise<{ course: string; concepts: number }> {
  if (bound && course !== bound) throw new CodemmError(`This job saves only course "${bound}".`);
  const roadmap = parseRoadmapYaml(yaml);
  const record: CourseRecord = { format_version: 1, course, ...roadmap };
  // Course lock, then the track's lock (as saveExercise does), so an install can't land between this check and the save.
  const save = async () => {
    const track = roadmap.track ? store.readTrack(roadmap.track) : undefined;
    if (track && roadmap.style !== "none" && roadmap.style !== "quiz" && !track.styles.includes(roadmap.style)) throw new CodemmError(`Track ${roadmap.track} offers ${track.styles.join(", ")}, not style "${roadmap.style}".`);
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
    // The retries go first, so a failed save converges when it's saved again. If an append fails, the roadmap remains
    // unchanged, so the re-save still sees the new prerequisite for every concept still stuck. If writing the roadmap
    // then fails, those concepts have their fresh start (no longer stuck, so no second retry unless they fail again)
    // and the re-save writes the roadmap. Until then, a concept can be offered before its new prerequisite exists.
    for (const concept of retries) store.appendEvent(course, { format_version: 1, kind: "retry", at: new Date().toISOString(), concept });
    store.writeCourse(record);
  };
  await store.withLock(store.courseLockPath(course), () => roadmap.track
    ? store.withLock(store.trackLockPath(store.parseTrackRef(roadmap.track).id), save)
    : save());
  if (activate) await store.updateWorkspace(ws, (config) => ({ ...config, course, current: config.course === course ? config.current : undefined }));
  return { course, concepts: roadmap.concepts.length };
}

/** With `withContract`, an installed track's contract too (as next_step's author step has it), for lesson examples. */
export function getRoadmap(ws: string, bound?: string, withContract = false) {
  const { course, title, goal, track, style, concepts, sources } = activeCourse(ws, bound);
  const installed = withContract && style !== "quiz" && track ? store.readTrack(track) : undefined;
  return { course, ...(title ? { title } : {}), goal, track, style, concepts, ...(sources ? { sources } : {}), ...(installed && style !== "quiz" ? { contract: trackContract(installed, style === "none" ? installed.styles[0]! : style) } : {}) };
}
