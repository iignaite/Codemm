import type { LlmProvider, LlmRole } from "./llm";

export type Difficulty = "easy" | "medium" | "hard";

export type GenerationLanguage = "java" | "python" | "cpp" | "sql";

export type GenerationFailureKind =
  | "compile"
  | "tests"
  | "timeout"
  | "contract"
  | "quality"
  | "llm"
  | "unknown";

export type RepairStrategy =
  | "retry_full_slot"
  | "repair_reference_solution"
  | "repair_test_suite"
  | "downgrade_difficulty"
  | "narrow_topics";

export type CompletionUsageDto = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CompletionMetaDto = {
  provider: LlmProvider;
  model?: string;
  role?: LlmRole;
  finishReason?: string;
  truncated?: boolean;
  usage?: CompletionUsageDto;
};

export type SlotIntentDto = {
  slotIndex: number;
  language: GenerationLanguage;
  difficulty: Difficulty;
  topics: string[];
  constraints: string;
  problemStyle: "stdout" | "return" | "mixed";
  testCaseCount: number;
};

export type GenerationArtifactSetDto = {
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

export type AttemptDiagnosticDto = {
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
  llm?: CompletionMetaDto;
  slotIntent?: SlotIntentDto;
  artifactSet?: GenerationArtifactSetDto;
  repairStrategy?: RepairStrategy;
};

export type GenerationRouteSelectionDto = {
  ts: string;
  slotIndex: number;
  routeRole: LlmRole;
  provider?: string;
  model?: string;
  capability?: string;
  promptTemplateId?: string;
};

export type GenerationStageTimelineEntryDto = {
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

export type GenerationFailureDiagnosticDto = {
  slotIndex: number;
  attempt: number;
  kind: string;
  message: string;
  remediation: string[];
  final: boolean;
  stage?: "skeleton" | "tests" | "reference" | "validate" | "repair";
  terminationReason?: string;
};

export type GenerationRoutePlanSummaryDto = {
  provider?: string;
  baseURL?: string;
  revision?: string;
  routingProfile?: string;
  defaultModel?: string;
  modelsByRole?: Record<string, { model?: string; capability?: string; fallbackChain?: string[] }>;
};

export type GenerationRunMetaDto = {
  id: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  meta: ({ routePlan?: GenerationRoutePlanSummaryDto | null } & Record<string, unknown>) | null;
};

export type GenerationDiagnosticsSummaryDto = {
  totalAttempts: number;
  failedAttempts: number;
  successfulAttempts: number;
  finalFailureKind?: string;
  llmMs?: number;
  dockerMs?: number;
  totalStageMs?: number;
};

export type GenerationDiagnosticsDto = {
  threadId: string;
  runId: string | null;
  run: GenerationRunMetaDto | null;
  summary: GenerationDiagnosticsSummaryDto;
  diagnostics: AttemptDiagnosticDto[];
  routeSelections: GenerationRouteSelectionDto[];
  stageTimeline: GenerationStageTimelineEntryDto[];
  latestFailure: GenerationFailureDiagnosticDto | null;
  errors: Array<{ seq: number; message: string; createdAt: string }>;
};

export type GenerationProgressEvent =
  | { type: "generation_started"; totalSlots: number; totalProblems?: number; run?: number }
  | {
      type: "route_selected";
      slotIndex: number;
      routeRole: LlmRole;
      provider?: string;
      model?: string;
      capability?: string;
      promptTemplateId?: string;
    }
  | {
      type: "slot_stage_started";
      slotIndex: number;
      stage: "skeleton" | "tests" | "reference" | "validate" | "repair";
      attempt: number;
      routeRole?: LlmRole;
      provider?: string;
      model?: string;
      promptTemplateId?: string;
      startedAt?: string;
    }
  | {
      type: "slot_stage_finished";
      slotIndex: number;
      stage: "skeleton" | "tests" | "reference" | "validate" | "repair";
      attempt: number;
      status: "success" | "failed";
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
    }
  | {
      type: "slot_escalated";
      slotIndex: number;
      stage: "tests" | "reference" | "repair";
      routeRole: LlmRole;
      fromModel?: string;
      toModel?: string;
      reason: string;
    }
  | {
      type: "slot_failed_terminal";
      slotIndex: number;
      stage: "skeleton" | "tests" | "reference" | "validate" | "repair";
      routeRole?: LlmRole;
      failureKind: GenerationFailureKind;
      terminationReason: string;
      message: string;
    }
  | {
      type: "slot_started";
      slotIndex: number;
      difficulty: Difficulty;
      topic: string;
      language: GenerationLanguage;
    }
  | { type: "slot_llm_attempt_started"; slotIndex: number; attempt: number }
  | { type: "slot_contract_validated"; slotIndex: number; attempt: number }
  | {
      type: "slot_evidence";
      slotIndex: number;
      attempt: number;
      obligations?: Array<{ id: string; ok: boolean; message?: string }>;
      qualityGate?: { baselines: Array<{ id: string; ok: boolean }> };
      rewrites?: Array<{ id: string; applied: boolean; detail?: string }>;
    }
  | { type: "slot_contract_failed"; slotIndex: number; attempt: number; shortError: string }
  | { type: "slot_docker_validation_started"; slotIndex: number; attempt: number }
  | { type: "slot_docker_validation_failed"; slotIndex: number; attempt: number; shortError: string }
  | {
      type: "slot_attempt_summary";
      slotIndex: number;
      attempt: number;
      maxAttempts: number;
      phase: "generate" | "validate" | "quality" | "complete";
      status: "success" | "failed";
      kind?: GenerationFailureKind;
      message?: string;
      remediation?: string[];
      llmOutputHash?: string;
      llm?: {
        provider: LlmProvider;
        model?: string;
        role?: LlmRole;
        finishReason?: string;
        truncated?: boolean;
        usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      };
      slotIntent?: {
        slotIndex: number;
        language: GenerationLanguage;
        difficulty: Difficulty;
        topics: string[];
        constraints: string;
        problemStyle: "stdout" | "return" | "mixed";
        testCaseCount: number;
      };
      artifactSet?: {
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
    }
  | {
      type: "slot_failure_diagnostic";
      slotIndex: number;
      attempt: number;
      kind: GenerationFailureKind;
      message: string;
      remediation: string[];
      final: boolean;
    }
  | {
      type: "slot_repair_applied";
      slotIndex: number;
      attempt: number;
      strategy: RepairStrategy;
      detail?: string;
    }
  | { type: "slot_completed"; slotIndex: number }
  | { type: "generation_completed"; activityId: string }
  | { type: "generation_failed"; error: string; slotIndex?: number }
  | { type: "generation_soft_fallback_applied"; reason: string; patchPaths: string[] }
  | { type: "heartbeat"; ts: string }
  | { type: "problem_started"; index: number; difficulty: Difficulty }
  | { type: "attempt_started"; index: number; attempt: number }
  | { type: "validation_started"; index: number; attempt: number }
  | { type: "validation_failed"; index: number; attempt: number }
  | { type: "attempt_failed"; index: number; attempt: number; phase: "generate" | "validate" }
  | { type: "problem_validated"; index: number }
  | { type: "problem_failed"; index: number }
  | { type: "generation_complete"; activityId: string };
