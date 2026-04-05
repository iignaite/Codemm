import type { ActivitySpec } from "../contracts/activitySpec";

export const REQUIRED_CONFIDENCE: Partial<Record<keyof ActivitySpec, number>> = {
  language: 0.9,
  problem_count: 0.8,
  difficulty_plan: 0.8,
  topic_tags: 0.6,
  problem_style: 0.6,
};
