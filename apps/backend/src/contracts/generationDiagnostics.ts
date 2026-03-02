import type { Difficulty } from "./activitySpec";
import type { CompletionMeta } from "../infra/llm/types";
import type { GenerationFailureKind } from "../generation/errors";

export type RepairStrategy =
  | "retry_full_slot"
  | "repair_reference_solution"
  | "repair_test_suite"
  | "downgrade_difficulty"
  | "narrow_topics";

export type SlotIntent = {
  slotIndex: number;
  language: "java" | "python" | "cpp" | "sql";
  difficulty: Difficulty;
  topics: string[];
  constraints: string;
  problemStyle: "stdout" | "return" | "mixed";
  testCaseCount: number;
};

export type GenerationArtifactSet = {
  title?: string;
  language: "java" | "python" | "cpp" | "sql";
  hasWorkspace: boolean;
  hashes: {
    testSuite?: string;
    reference?: string;
    starter?: string;
    description?: string;
  };
};

export type AttemptDiagnostic = {
  ts: string;
  slotIndex: number;
  attempt: number;
  maxAttempts: number;
  phase: "generate" | "validate" | "quality" | "complete";
  status: "success" | "failed";
  kind?: GenerationFailureKind;
  message?: string;
  remediation?: string[];
  llmOutputHash?: string;
  llm?: CompletionMeta;
  slotIntent?: SlotIntent;
  artifactSet?: GenerationArtifactSet;
  repairStrategy?: RepairStrategy;
};

