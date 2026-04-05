import { z } from "zod";
import type { CompletionMeta } from "../infra/llm/types";
import type { GeneratedProblemDraft } from "./problem";
import type { SlotIntent } from "./generationDiagnostics";

export const SlotSkeletonSchema = z
  .object({
    language: z.enum(["java", "python", "cpp", "sql"]),
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(8000),
    constraints: z.string().trim().min(1).max(2000),
    sample_inputs: z.array(z.string().trim().min(1).max(4000)).min(1).max(10),
    sample_outputs: z.array(z.string().trim().min(1).max(4000)).min(1).max(10),
    difficulty: z.enum(["easy", "medium", "hard"]),
    topic_tag: z.string().trim().min(1).max(40),
  })
  .strict();

export type SlotSkeleton = z.infer<typeof SlotSkeletonSchema>;

export const SlotTestsSchema = z
  .object({
    test_suite: z.string().trim().min(1),
  })
  .strict();

export type SlotTests = z.infer<typeof SlotTestsSchema>;

export const SlotReferenceSchema = z
  .object({
    reference_solution: z.string().trim().min(1),
  })
  .strict();

export type SlotReference = z.infer<typeof SlotReferenceSchema>;

export type SlotValidationState = {
  validatedAt?: string;
  docker?: {
    exitCode?: number;
    timedOut?: boolean;
    stdoutHash?: string;
    stderrHash?: string;
  };
};

export type SlotDraftEnvelope = {
  slotIntent: SlotIntent;
  skeleton?: SlotSkeleton;
  tests?: SlotTests;
  reference?: SlotReference;
  learnerArtifact?: GeneratedProblemDraft;
  validationState?: SlotValidationState;
};

export type SlotStageName = "skeleton" | "tests" | "reference" | "validate" | "repair" | "complete";

export type SlotStageResult<T> = {
  value: T;
  llm?: CompletionMeta;
  llmOutputHash?: string;
  promptTemplateId: string;
  artifactHash?: string;
};
