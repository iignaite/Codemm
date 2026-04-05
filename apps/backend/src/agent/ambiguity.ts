import type { ActivitySpec } from "../contracts/activitySpec";
import type { ConfidenceMap } from "./readiness";
import { REQUIRED_CONFIDENCE } from "./policy";

export enum AmbiguityRisk {
  SAFE = "SAFE",
  DEFERABLE = "DEFERABLE",
  BLOCKING = "BLOCKING",
}

export const BLOCKING_CONFIDENCE: Partial<Record<keyof ActivitySpec, number>> = {
  language: 0.6,
  problem_count: 0.5,
  difficulty_plan: 0.5,
  topic_tags: 0.3,
  problem_style: 0.4,
};

export function getConfidence(confidence: ConfidenceMap | null | undefined, key: keyof ActivitySpec): number {
  const raw = confidence?.[String(key)];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

export function classifyAmbiguityRisk(field: keyof ActivitySpec, confidence: number): AmbiguityRisk {
  const required = (REQUIRED_CONFIDENCE as any)[field];
  const requiredThreshold = typeof required === "number" ? required : 1;
  const blocking = (BLOCKING_CONFIDENCE as any)[field];
  const blockingThreshold = typeof blocking === "number" ? blocking : Math.min(0.25, requiredThreshold);

  if (confidence >= requiredThreshold) return AmbiguityRisk.SAFE;
  if (confidence >= blockingThreshold) return AmbiguityRisk.DEFERABLE;
  return AmbiguityRisk.BLOCKING;
}
