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
export async function saveRoadmap(ws: string, course: string, yaml: string, bound?: string): Promise<{ course: string; concepts: number }> {
  if (bound && course !== bound) throw new CodemmError(`This job saves only course "${bound}".`);
  const roadmap = parseRoadmapYaml(yaml);
  const record: CourseRecord = { format_version: 1, course, ...roadmap };
  // Course lock, then the track's lock (as saveExercise does), so an install can't land between this check and the save.
  await store.withLock(store.courseLockPath(course), () => store.withLock(store.trackLockPath(store.parseTrackRef(roadmap.track).id), async () => {
    const track = store.readTrack(roadmap.track);
    if (track && !track.styles.includes(roadmap.style)) throw new CodemmError(`Track ${roadmap.track} offers ${track.styles.join(", ")}, not style "${roadmap.style}".`);
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
    // The retries go first, so a failed save always converges when it's saved again. If appending fails, nothing was
    // written and the re-save still sees the new prerequisite. If writing the roadmap then fails, the concept has its
    // fresh start (so it's no longer stuck and gets no second retry) and the re-save writes the roadmap.
    for (const concept of retries) store.appendEvent(course, { format_version: 1, kind: "retry", at: new Date().toISOString(), concept });
    store.writeCourse(record);
  }));
  await store.updateWorkspace(ws, (config) => ({ ...config, course, current: config.course === course ? config.current : undefined }));
  return { course, concepts: roadmap.concepts.length };
}

/** With `withContract`, an installed track's contract too (as next_step's author step has it), for lesson examples. */
export function getRoadmap(ws: string, bound?: string, withContract = false) {
  const { course, goal, track, style, concepts, sources } = activeCourse(ws, bound);
  const installed = withContract ? store.readTrack(track) : undefined;
  return { course, goal, track, style, concepts, ...(sources ? { sources } : {}), ...(installed ? { contract: trackContract(installed, style) } : {}) };
}
