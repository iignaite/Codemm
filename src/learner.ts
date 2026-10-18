/**
 * Learner rules. Pure functions of the attempt log: the log is the only learner
 * state, and everything here is recomputed by replaying it.
 */

export const PRIOR = 0.5;
export const RATE = 0.3;
export const ASSISTED_WEIGHT = 0.25;
export const MASTERED = 0.85;
const MAX_DIFFICULTY = 3;
/** Days from mastering a concept, then from each passed review, to the next review. */
export const REVIEW_DAYS = [1, 3, 7, 21, 60];
const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

export type CheckEvent = {
  format_version: 1;
  kind: "check";
  at: string;
  exercise: string;
  concepts: string[];
  difficulty: number;
  passed: number;
  total: number;
  assisted: boolean;
};
/** "Come back later": defers the concept until its next check. Never changes mastery. */
export type SkipEvent = { format_version: 1; kind: "skip"; at: string; concept: string };
/** Marks an exercise as assisted for good: every check of it counts as assisted. */
export type AssistEvent = { format_version: 1; kind: "assist"; at: string; exercise: string };
/** A fresh start after a new prerequisite: resets the fail streak, leaves mastery alone. */
export type RetryEvent = { format_version: 1; kind: "retry"; at: string; concept: string };
/** The learner acknowledged reading a lesson. Never changes mastery. */
export type ReadEvent = { format_version: 1; kind: "read"; at: string; lesson: string; concept: string };
export type LearnerEvent = CheckEvent | SkipEvent | AssistEvent | RetryEvent | ReadEvent;

export type ConceptState = {
  mastery: number;
  difficulty: number;
  failStreak: number;
  attempts: number;
  stuck: boolean;
  deferred: boolean;
  /** For a mastered concept: the next review (index into REVIEW_DAYS, and when it's due). Absent after the last. */
  review?: { stage: number; due: string };
};

export type RoadmapGraph = { concepts: { id: string; requires: string[] }[] };
export type ExerciseSummary = { slug: string; concepts: string[]; difficulty: number };
/** Lessons in the order they were saved. */
export type LessonSummary = { id: string; concept: string };

/**
 * `lesson` on practice and author steps: null when the concept has no lesson yet, the earliest unread
 * lesson's id, or absent once every lesson for the concept is read.
 */
export type Step =
  | { kind: "practice"; exercise: string; concept: string; difficulty: number; lesson?: string | null }
  | { kind: "author"; concept: string; difficulty: number; lesson?: string | null; review?: true }
  | { kind: "review"; concept: string; difficulty: number; exercise: string }
  | { kind: "stuck"; concept: string }
  | { kind: "done" };

const fresh = (): ConceptState => ({ mastery: PRIOR, difficulty: 1, failStreak: 0, attempts: 0, stuck: false, deferred: false });

const isPerfect = (e: CheckEvent) => e.total > 0 && e.passed === e.total;

export function replay(log: LearnerEvent[]): Map<string, ConceptState> {
  const states = new Map<string, ConceptState>();
  const get = (concept: string) => {
    const s = states.get(concept) ?? fresh();
    states.set(concept, s);
    return s;
  };
  const best = new Map<string, number>();
  const assistedExercises = new Set<string>();

  for (const a of log) {
    if (a.kind === "skip") {
      get(a.concept).deferred = true;
      continue;
    }
    if (a.kind === "retry") {
      const s = get(a.concept);
      s.failStreak = 0;
      s.stuck = false;
      continue;
    }
    if (a.kind === "assist") {
      assistedExercises.add(a.exercise);
      continue;
    }
    if (a.kind === "read") continue;
    const score = a.total > 0 ? a.passed / a.total : 0;
    const previousBest = best.get(a.exercise);
    const firstTry = previousBest === undefined;
    const perfect = isPerfect(a);
    // Any check ends a deferral, even one that earns nothing.
    for (const concept of a.concepts) get(concept).deferred = false;
    // Re-checking an already solved exercise is feedback only, never new evidence.
    if (perfect && previousBest === 1) continue;
    // Mastery moves only on a first check or a better best score, so retrying the same partial answer adds nothing.
    const improves = firstTry || score > previousBest;
    if (improves) best.set(a.exercise, score);
    const assisted = a.assisted || assistedExercises.has(a.exercise);

    for (const concept of new Set(a.concepts)) {
      const s = get(concept);
      const wasMastered = s.mastery >= MASTERED;
      const reviewing = s.review !== undefined && Date.parse(a.at) >= Date.parse(s.review.due);
      if (improves) s.mastery += RATE * (assisted ? ASSISTED_WEIGHT : 1) * (score - s.mastery);
      s.attempts += 1;

      if (perfect) {
        s.failStreak = 0;
        if (firstTry && !assisted) s.difficulty = Math.min(MAX_DIFFICULTY, s.difficulty + 1);
      } else {
        s.failStreak += 1;
        if (s.failStreak >= 2 && s.difficulty > 1) {
          s.difficulty -= 1;
          s.failStreak = 0;
        }
      }
      s.stuck = s.difficulty === 1 && s.failStreak >= 2;

      // A check once a review is due is the review: a pass moves to the next interval, a fail means practice again.
      if (reviewing && perfect) {
        const stage = s.review!.stage + 1;
        s.review = stage < REVIEW_DAYS.length ? { stage, due: addDays(a.at, REVIEW_DAYS[stage]!) } : undefined;
      } else if (reviewing) {
        s.mastery = Math.min(s.mastery, MASTERED - 0.1);
      } else if (!wasMastered && s.mastery >= MASTERED) {
        s.review = { stage: 0, due: addDays(a.at, REVIEW_DAYS[0]!) };
      }
      if (s.mastery < MASTERED) s.review = undefined;
    }
  }
  return states;
}

/** Concept ids in topological order (prerequisites first, ties by roadmap order). Assumes no cycles. */
export function topoOrder(roadmap: RoadmapGraph): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const remaining = [...roadmap.concepts];
  while (remaining.length > 0) {
    const i = remaining.findIndex((c) => c.requires.every((r) => done.has(r)));
    if (i < 0) break;
    const [c] = remaining.splice(i, 1);
    order.push(c!.id);
    done.add(c!.id);
  }
  return order;
}

/** `now` decides which reviews are due. */
export function nextStep(roadmap: RoadmapGraph, exercises: ExerciseSummary[], log: LearnerEvent[], lessons: LessonSummary[], now: string): Step {
  const states = replay(log);
  const state = (id: string) => states.get(id) ?? fresh();
  const mastered = (id: string) => state(id).mastery >= MASTERED;
  const order = topoOrder(roadmap);
  const requires = new Map(roadmap.concepts.map((c) => [c.id, c.requires]));

  // Due reviews come first, the earliest due first: a check on an exercise the learner hasn't tried, at the
  // mastered difficulty, or a new one.
  const dueAt = (id: string) => Date.parse(state(id).review?.due ?? "");
  const due = order.filter((id) => mastered(id) && dueAt(id) <= Date.parse(now)).sort((a, b) => dueAt(a) - dueAt(b));
  if (due.length > 0) {
    const concept = due[0]!;
    const difficulty = state(concept).difficulty;
    const tried = new Set(log.flatMap((a) => (a.kind === "check" ? [a.exercise] : [])));
    const unused = exercises.find((e) => e.concepts.includes(concept) && e.difficulty === difficulty && !tried.has(e.slug));
    return unused ? { kind: "review", concept, difficulty, exercise: unused.slug } : { kind: "author", concept, difficulty, review: true };
  }

  const candidates = order.filter((id) => !mastered(id) && (requires.get(id) ?? []).every(mastered));
  if (candidates.length === 0) return { kind: "done" };

  // Deferred concepts wait while anything else is open; if all are deferred, the earliest comes back first.
  // Stable sort keeps topological order for ties.
  const open = candidates.filter((id) => !state(id).deferred);
  const concept = open.length > 0 ? [...open].sort((a, b) => state(a).mastery - state(b).mastery)[0]! : candidates[0]!;
  const s = state(concept);
  if (s.stuck) return { kind: "stuck", concept };

  const read = new Set(log.flatMap((a) => (a.kind === "read" ? [a.lesson] : [])));
  const own = lessons.filter((l) => l.concept === concept);
  const unread = own.find((l) => !read.has(l.id));
  const lesson = own.length === 0 ? { lesson: null } : unread ? { lesson: unread.id } : {};

  const passed = new Set(log.flatMap((a) => (a.kind === "check" && isPerfect(a) ? [a.exercise] : [])));
  const fit = exercises.find((e) => e.concepts.includes(concept) && e.difficulty === s.difficulty && !passed.has(e.slug));
  if (fit) return { kind: "practice", exercise: fit.slug, concept, difficulty: s.difficulty, ...lesson };
  return { kind: "author", concept, difficulty: s.difficulty, ...lesson };
}
