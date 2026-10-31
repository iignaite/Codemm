import { CodemmError } from "../errors.js";
import { MASTERED, coveredConcepts, replay } from "../learner.js";
import { assertRuntime } from "../sandbox.js";
import * as store from "../store.js";
import { activeCourse, noteAssistLocked } from "./shared.js";
import { nextStep } from "./exercises.js";

// ---------- progress ----------

export function progress(ws: string, bound?: string) {
  const course = activeCourse(ws, bound);
  const log = store.readEvents(course.course);
  const states = replay(log);
  const covered = coveredConcepts(log, store.listLessons(course.course));
  return {
    course: course.course,
    goal: course.goal,
    track: course.track,
    style: course.style,
    concepts: course.concepts.map((c) => {
      const s = states.get(c.id);
      const mastery = s?.mastery ?? 0.5;
      return {
        id: c.id, title: c.title, requires: c.requires, covered: covered.has(c.id), mastery: Math.round(mastery * 1000) / 1000,
        mastered: mastery >= MASTERED, difficulty: s?.difficulty ?? 1, attempts: s?.attempts ?? 0, stuck: s?.stuck ?? false,
        ...(s?.review ? { reviewDue: s.review.due } : {}),
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
  // Turning assistance on records the evidence first, then grants the permission, in one workspace-locked step, so
  // opening another exercise meanwhile can't leave the permission without its evidence.
  await store.updateWorkspace(ws, async (c) => {
    const { course, current } = c;
    if (on && course && current) await store.withLock(store.courseLockPath(course), async () => noteAssistLocked(course, current));
    return { ...c, assist: on };
  });
}

export { assertRuntime };
