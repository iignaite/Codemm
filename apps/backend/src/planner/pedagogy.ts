import type { LearningMode } from "../contracts/learningMode";
import type { ActivitySpec } from "../contracts/activitySpec";
import type { MasterySnapshot } from "../contracts/learner";
import { normalizeConceptKey } from "../learning/mastery";

/**
 * Planner-level pedagogy policy.
 *
 * This affects how an activity is structured pedagogically (ordering/scaffolding),
 * without changing generation safety contracts or Docker verification.
 *
 * Phase 2A: policy is consumed only to annotate plan slots with optional pedagogy metadata.
 */
export type PedagogyPolicy =
  | { mode: Extract<LearningMode, "practice"> }
  | {
      mode: Extract<LearningMode, "guided">;
      scaffold_curve?: number[];
      focus_concepts?: string[];
      hints_enabled?: boolean;
    };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function baseScaffoldForIndex(index: number): number {
  if (index <= 0) return 80;
  if (index === 1) return 60;
  if (index === 2) return 30;
  // After the first 3, keep a minimal scaffold.
  return 10;
}

function masteryForTag(tag: string, mastery: Record<string, number>): number {
  const v = mastery[normalizeConceptKey(tag)];
  return typeof v === "number" ? clamp01(v) : 0.5;
}

function computeAverageMastery(tags: string[], mastery: Record<string, number> | null | undefined): number {
  if (!tags.length) return 0.5;
  const m = mastery ?? {};
  let sum = 0;
  for (const t of tags) {
    sum += masteryForTag(t, m);
  }
  return sum / tags.length;
}

export function buildGuidedPedagogyPolicy(args: {
  spec: ActivitySpec;
  masterySnapshot?: MasterySnapshot | null;
}): PedagogyPolicy {
  const mastery = args.masterySnapshot?.concept_mastery ?? {};
  const focus_concepts = [...args.spec.topic_tags]
    .map((t) => ({ t, v: masteryForTag(t, mastery) }))
    .sort((a, b) => (a.v === b.v ? a.t.localeCompare(b.t) : a.v - b.v))
    .map((x) => x.t);

  const avg = computeAverageMastery(args.spec.topic_tags, mastery);
  const scaffold_curve = Array.from({ length: args.spec.problem_count }, (_v, i) => baseScaffoldForIndex(i));

  return {
    mode: "guided",
    scaffold_curve,
    focus_concepts,
    hints_enabled: avg < 0.6,
  };
}
