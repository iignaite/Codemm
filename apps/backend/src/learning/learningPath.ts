import type { ActivityLanguage } from "../contracts/activitySpec";
import type { ConceptMastery } from "../contracts/learner";
import { masteryLevelFor, MASTERY_LEVELS, type MasteryLevel } from "./mastery";

/**
 * Deterministic learning-path engine.
 *
 * Pure functions only — no LLM, no I/O. A learning path is a skill map derived
 * from the learner's persisted per-concept mastery: what they've practiced,
 * how well, what to work on next. The LLM's job is to generate activities for a
 * concept; deciding the ordering and what counts as "mastered" is deterministic.
 */

/** A concept is mastered once mastery reaches the "mastered" band. */
export const MASTERED_THRESHOLD = MASTERY_LEVELS.find((l) => l.level === "mastered")!.min;

export type ModuleStatus = "not_started" | "in_progress" | "mastered";

export type LearningPathModule = {
  concept: string;
  mastery: number;
  level: MasteryLevel;
  status: ModuleStatus;
  attempts: number;
  passes: number;
  recommended: boolean;
};

export type LearningPath = {
  language: ActivityLanguage;
  modules: LearningPathModule[];
  recommendedConcept: string | null;
  overallMastery: number;
  masteredCount: number;
  totalCount: number;
  builtAt: string;
};

function statusFor(record: ConceptMastery): ModuleStatus {
  if (record.attempts <= 0) return "not_started";
  return record.mastery >= MASTERED_THRESHOLD ? "mastered" : "in_progress";
}

/**
 * Order: weakest-first among started concepts (most in need of work), then
 * not-yet-started concepts, then mastered ones. Ties break alphabetically so
 * the roadmap is stable across rebuilds.
 */
function compareModules(a: LearningPathModule, b: LearningPathModule): number {
  const rank: Record<ModuleStatus, number> = { in_progress: 0, not_started: 1, mastered: 2 };
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
  if (a.status === "in_progress" && a.mastery !== b.mastery) return a.mastery - b.mastery;
  return a.concept.localeCompare(b.concept);
}

export function buildLearningPath(args: {
  language: ActivityLanguage;
  concepts: ConceptMastery[];
  builtAt: string;
}): LearningPath {
  const modules: LearningPathModule[] = args.concepts.map((record) => ({
    concept: record.concept,
    mastery: record.mastery,
    level: masteryLevelFor(record.mastery),
    status: statusFor(record),
    attempts: record.attempts,
    passes: record.passes,
    recommended: false,
  }));

  modules.sort(compareModules);

  // Recommend the first non-mastered module in path order (weakest started
  // concept, else the first not-started one). Null when everything is mastered.
  const recommended = modules.find((m) => m.status !== "mastered") ?? null;
  if (recommended) recommended.recommended = true;

  const totalCount = modules.length;
  const masteredCount = modules.filter((m) => m.status === "mastered").length;
  const overallMastery = totalCount > 0 ? modules.reduce((sum, m) => sum + m.mastery, 0) / totalCount : 0;

  return {
    language: args.language,
    modules,
    recommendedConcept: recommended ? recommended.concept : null,
    overallMastery,
    masteredCount,
    totalCount,
    builtAt: args.builtAt,
  };
}
