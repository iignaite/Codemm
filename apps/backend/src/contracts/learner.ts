import { z } from "zod";
import { ActivityLanguageSchema } from "./activitySpec";

/**
 * Local-first learner model.
 *
 * There is exactly one learner per workspace: the person using this machine.
 * No user ids, no accounts. Mastery is tracked per (language, concept) where
 * a concept is currently a normalized topic tag (see docs/codemm-architecture-review.md §10.3).
 */

export const LearnerPreferredStyleSchema = z.enum(["guided", "exploratory"]);
export type LearnerPreferredStyle = z.infer<typeof LearnerPreferredStyleSchema>;

/** Concepts are tag-keyed for now; normalized to lowercase trimmed strings. */
export const ConceptKeySchema = z.string().trim().min(1).max(64);

export const LocalLearnerProfileSchema = z
  .object({
    goal: z.string().trim().max(500).nullable(),
    preferred_style: LearnerPreferredStyleSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type LocalLearnerProfile = z.infer<typeof LocalLearnerProfileSchema>;

export const ConceptMasterySchema = z
  .object({
    language: ActivityLanguageSchema,
    concept: ConceptKeySchema,
    mastery: z.number().min(0).max(1),
    attempts: z.number().int().min(0),
    passes: z.number().int().min(0),
    last_attempt_at: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();

export type ConceptMastery = z.infer<typeof ConceptMasterySchema>;

/** Per-language view of mastery, consumed by planning/pedagogy. */
export const MasterySnapshotSchema = z
  .object({
    language: ActivityLanguageSchema,
    concept_mastery: z.record(ConceptKeySchema, z.number().min(0).max(1)),
    taken_at: z.string(),
  })
  .strict();

export type MasterySnapshot = z.infer<typeof MasterySnapshotSchema>;
