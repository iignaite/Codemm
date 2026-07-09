import type { ActivityLanguage } from "../contracts/activitySpec";
import type { ConceptMastery } from "../contracts/learner";

/**
 * Deterministic mastery progression.
 *
 * Pure functions only: the LLM never decides mastery, and no I/O happens here.
 * Mastery moves toward the observed test-pass ratio with a bounded learning
 * rate, so a single lucky (or unlucky) submission cannot swing the estimate.
 */

/** Prior for a concept with no evidence; matches the planner's neutral default. */
export const MASTERY_PRIOR = 0.5;

/** Fraction of the gap between current mastery and observed score applied per attempt. */
export const MASTERY_LEARNING_RATE = 0.3;

export const MASTERY_LEVELS = [
  { level: "mastered", min: 0.85 },
  { level: "proficient", min: 0.6 },
  { level: "developing", min: 0.4 },
  { level: "novice", min: 0 },
] as const;

export type MasteryLevel = (typeof MASTERY_LEVELS)[number]["level"];

export type AttemptEvidence = {
  passed: boolean;
  passedTests: number;
  totalTests: number;
  /** ISO timestamp of the attempt. */
  at: string;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function masteryLevelFor(mastery: number): MasteryLevel {
  const value = clamp01(mastery);
  const entry = MASTERY_LEVELS.find((candidate) => value >= candidate.min);
  return entry ? entry.level : "novice";
}

/** Normalize a free-text topic tag into a stable concept key. */
export function normalizeConceptKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 64);
}

/** Observed score for an attempt: the test-pass ratio. */
export function attemptScore(evidence: AttemptEvidence): number {
  if (evidence.totalTests > 0) return clamp01(evidence.passedTests / evidence.totalTests);
  return evidence.passed ? 1 : 0;
}

/**
 * Fold one attempt into a concept's mastery record.
 * Returns a new record; never mutates `prev`.
 */
export function applyAttemptEvidence(
  prev: ConceptMastery | undefined,
  args: { language: ActivityLanguage; concept: string; evidence: AttemptEvidence }
): ConceptMastery {
  const concept = normalizeConceptKey(args.concept);
  const base = prev ? clamp01(prev.mastery) : MASTERY_PRIOR;
  const score = attemptScore(args.evidence);
  const mastery = clamp01(base + MASTERY_LEARNING_RATE * (score - base));

  return {
    language: args.language,
    concept,
    mastery,
    attempts: (prev?.attempts ?? 0) + 1,
    passes: (prev?.passes ?? 0) + (args.evidence.passed ? 1 : 0),
    last_attempt_at: args.evidence.at,
    updated_at: args.evidence.at,
  };
}
