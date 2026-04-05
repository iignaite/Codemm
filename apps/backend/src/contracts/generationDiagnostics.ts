import type { Difficulty, GenerationFailureKind, GenerationLanguage, RepairStrategy } from "@codemm/shared-contracts";
import type { CompletionMeta } from "../infra/llm/types";
import type { LlmRole } from "../infra/llm/types";

export type SlotIntent = {
  slotIndex: number;
  language: GenerationLanguage;
  difficulty: Difficulty;
  topics: string[];
  constraints: string;
  problemStyle: "stdout" | "return" | "mixed";
  testCaseCount: number;
};

export type GenerationArtifactSet = {
  title?: string;
  language: GenerationLanguage;
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

export type GenerationRouteSelection = {
  ts: string;
  slotIndex: number;
  routeRole: LlmRole;
  provider?: string;
  model?: string;
  capability?: string;
  promptTemplateId?: string;
};

export type GenerationStageTimelineEntry = {
  ts: string;
  slotIndex: number;
  stage: "skeleton" | "tests" | "reference" | "validate" | "repair";
  attempt: number;
  status: "started" | "success" | "failed" | "escalated" | "terminal";
  routeRole?: LlmRole;
  provider?: string;
  model?: string;
  promptTemplateId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  artifactHash?: string;
  failureKind?: GenerationFailureKind;
  message?: string;
  exitCode?: number;
  timedOut?: boolean;
  terminationReason?: string;
  fromModel?: string;
  toModel?: string;
  reason?: string;
};
