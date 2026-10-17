/**
 * Learner rules. Pure functions of the attempt log: the log is the only learner
 * state, and everything here is recomputed by replaying it.
 */

export const PRIOR = 0.5;
export const RATE = 0.3;
export const ASSISTED_WEIGHT = 0.25;
export const MASTERED = 0.85;
const MAX_DIFFICULTY = 3;

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
export type SkipEvent = { format_version: 1; kind: "skip"; at: string; concept: string };
export type LearnerEvent = CheckEvent | SkipEvent;

export type ConceptState = {
  mastery: number;
  difficulty: number;
  failStreak: number;
  attempts: number;
  stuck: boolean;
};

export type RoadmapGraph = { concepts: { id: string; requires: string[] }[] };
export type ExerciseSummary = { slug: string; concepts: string[]; difficulty: number };

export type Step =
  | { kind: "practice"; exercise: string; concept: string; difficulty: number }
  | { kind: "author"; concept: string; difficulty: number }
  | { kind: "stuck"; concept: string }
  | { kind: "done" };

const fresh = (): ConceptState => ({ mastery: PRIOR, difficulty: 1, failStreak: 0, attempts: 0, stuck: false });

const isPerfect = (e: CheckEvent) => e.total > 0 && e.passed === e.total;

export function replay(log: LearnerEvent[]): Map<string, ConceptState> {
  const states = new Map<string, ConceptState>();
  const get = (concept: string) => {
    const s = states.get(concept) ?? fresh();
    states.set(concept, s);
    return s;
  };
  const checked = new Set<string>();
  const solved = new Set<string>();

  for (const a of log) {
    if (a.kind === "skip") {
      const s = get(a.concept);
      s.mastery = Math.max(s.mastery, MASTERED);
      continue;
    }
    const firstTry = !checked.has(a.exercise);
    checked.add(a.exercise);
    const perfect = isPerfect(a);
    // Re-checking an already solved exercise is feedback only, never new evidence.
    if (perfect && solved.has(a.exercise)) continue;
    if (perfect) solved.add(a.exercise);

    for (const concept of a.concepts) {
      const s = get(concept);
      const score = a.total > 0 ? a.passed / a.total : 0;
      const weight = a.assisted ? ASSISTED_WEIGHT : 1;
      s.mastery += RATE * weight * (score - s.mastery);
      s.attempts += 1;

      if (perfect) {
        s.failStreak = 0;
        if (firstTry && !a.assisted) s.difficulty = Math.min(MAX_DIFFICULTY, s.difficulty + 1);
      } else {
        s.failStreak += 1;
        if (s.failStreak >= 2 && s.difficulty > 1) {
          s.difficulty -= 1;
          s.failStreak = 0;
        }
      }
      s.stuck = s.difficulty === 1 && s.failStreak >= 2;
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

export function nextStep(roadmap: RoadmapGraph, exercises: ExerciseSummary[], log: LearnerEvent[]): Step {
  const states = replay(log);
  const state = (id: string) => states.get(id) ?? fresh();
  const mastered = (id: string) => state(id).mastery >= MASTERED;
  const order = topoOrder(roadmap);
  const requires = new Map(roadmap.concepts.map((c) => [c.id, c.requires]));

  const candidates = order.filter((id) => !mastered(id) && (requires.get(id) ?? []).every(mastered));
  if (candidates.length === 0) return { kind: "done" };

  // Stable sort keeps topological order for ties.
  const concept = [...candidates].sort((a, b) => state(a).mastery - state(b).mastery)[0]!;
  const s = state(concept);
  if (s.stuck) return { kind: "stuck", concept };

  const passed = new Set(log.flatMap((a) => (a.kind === "check" && isPerfect(a) ? [a.exercise] : [])));
  const fit = exercises.find((e) => e.concepts.includes(concept) && e.difficulty === s.difficulty && !passed.has(e.slug));
  if (fit) return { kind: "practice", exercise: fit.slug, concept, difficulty: s.difficulty };
  return { kind: "author", concept, difficulty: s.difficulty };
}
