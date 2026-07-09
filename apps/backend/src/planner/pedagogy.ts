import type { LearningMode } from "../contracts/learningMode";
import type { ActivitySpec } from "../contracts/activitySpec";
import type { MasterySnapshot } from "../contracts/learner";

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

function computeAverageMastery(tags: string[], mastery: Record<string, number> | null | undefined): number {
  if (!tags.length) return 0.5;
  const m = mastery ?? {};
  let sum = 0;
  for (const t of tags) {
    const v = typeof m[t] === "number" ? (m[t] as number) : 0.5;
    sum += clamp01(v);
  }
  return sum / tags.length;
}

export function buildGuidedPedagogyPolicy(args: {
  spec: ActivitySpec;
  masterySnapshot?: MasterySnapshot | null;
}): PedagogyPolicy {
  const mastery = args.masterySnapshot?.concept_mastery ?? {};
  const focus_concepts = [...args.spec.topic_tags]
    .map((t) => ({ t, v: typeof mastery[t] === "number" ? clamp01(mastery[t] as number) : 0.5 }))
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
