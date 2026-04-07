import type { LlmProvider, LlmRole } from "./llm";

export type Difficulty = "easy" | "medium" | "hard";

export type GenerationLanguage = "java" | "python" | "cpp" | "sql";

export type GenerationFailureKind =
  | "spec_error"
  | "generation_schema_error"
  | "static_rule_violation"
  | "api_shape_mismatch"
  | "complexity_risk_exceeded"
  | "compile_failure"
  | "test_failure"
  | "time_budget_exceeded"
  | "output_limit_exceeded"
  | "judge_infra_failure"
  | "repair_no_progress"
  | "run_policy_failure"
  | "compile"
  | "tests"
  | "timeout"
  | "contract"
  | "quality"
  | "llm"
  | "infra"
  | "unknown";

export type GenerationRunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "INCOMPLETE"
  | "PARTIAL_SUCCESS"
  | "RETRYABLE_FAILURE"
  | "HARD_FAILURE"
  | "ABORTED";

export type GenerationSlotStage =
  | "QUEUED"
  | "SKELETON_GENERATING"
  | "TESTS_GENERATING"
  | "REFERENCE_GENERATING"
  | "GENERATION_CONTRACT_VALIDATING"
  | "STATIC_ANALYSIS"
  | "API_SHAPE_VALIDATION"
  | "COMPLEXITY_RISK_ESTIMATION"
  | "EXECUTION_BUNDLE_READY"
  | "COMPILE_RUNNING"
  | "TEST_EXEC_RUNNING"
  | "QUALITY_GATE_RUNNING"
  | "FAILURE_DIAGNOSED"
  | "REPAIR_STRATEGY_SELECTED"
  | "REPAIR_GENERATING"
  | "REPAIR_SANITIZING"
  | "REPAIR_EXECUTING"
  | "SKELETON_RUNNING"
  | "TESTS_RUNNING"
  | "REFERENCE_RUNNING"
  | "VALIDATING_REFERENCE"
  | "REPAIRING_REFERENCE"
  | "VALIDATING_REPAIR"
  | "SUCCEEDED"
  | "RECOVERABLE_FAILED"
  | "FATAL_FAILED"
  | "QUARANTINED"
  | "RETRYABLE_FAILURE"
  | "HARD_FAILURE"
  | "SKIPPED";

export type GenerationSlotTerminalStatus =
  | "SUCCEEDED"
  | "RECOVERABLE_FAILED"
  | "FATAL_FAILED"
  | "QUARANTINED"
  | "RETRYABLE_FAILURE"
  | "HARD_FAILURE"
  | "SKIPPED";

export type JudgeFailureCategoryDto =
  | "COMPILE_FAILURE"
  | "TEST_FAILURE"
  | "TIME_BUDGET_EXCEEDED"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "JUDGE_INFRA_FAILURE"
  | "COMPILE_ERROR"
  | "TEST_FAILURE"
  | "EXEC_TIMEOUT"
  | "OUTPUT_LIMIT"
  | "INFRA_ERROR";

export type RepairStrategy =
  | "regenerate_reference_logic"
  | "regenerate_reference_shape"
  | "regenerate_tests_shape"
  | "tighten_constraints"
  | "inject_guardrails"
  | "quarantine_slot"
  | "retry_full_slot"
  | "repair_reference_solution"
  | "repair_test_suite"
  | "downgrade_difficulty"
  | "narrow_topics";

export type GenerationExecutionPhaseDto = "compile" | "test_exec" | "quality_gate";

export type GenerationSlotDiagnosisDto = {
  runId: string;
  slotIndex: number;
  attempt: number;
  diagnosisClass: string;
  recoverability: "recoverable" | "fatal" | "quarantine";
  normalizedSymptom: string;
  recommendedRepairStrategy?: RepairStrategy | null;
  sourceExecutionAttemptId?: number | null;
};

export type GenerationExecutionAttemptDto = {
  id: number;
  runId: string;
  slotIndex: number;
  attempt: number;
  executionPhase: GenerationExecutionPhaseDto;
  bundleHash: string;
  strategy?: RepairStrategy | null;
  budgetProfile?: Record<string, unknown> | null;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  timeoutStage?: "compile" | "execute" | "overall" | null;
  watchdogSource?: "inner" | "outer" | "unknown" | null;
  failureCategory?: JudgeFailureCategoryDto | GenerationFailureKind | null;
  stdoutHash?: string | null;
  stderrHash?: string | null;
  stdoutSnippet?: string | null;
  stderrSnippet?: string | null;
  parsedFailures?: Record<string, unknown> | null;
  trace?: Record<string, unknown> | null;
};

export type GenerationRunFailureCacheEntryDto = {
  runId: string;
  language: GenerationLanguage;
  topicSignature: string;
  failureClass: string;
  normalizedSymptom: string;
  guardrailPatch?: Record<string, unknown> | null;
  createdAt: string;
};

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

export type GenerationRunSummaryDto = {
  runId: string;
  threadId: string;
  status: GenerationRunStatus;
  activityId?: string | null;
  totalSlots: number;
  completedSlots: number;
  successfulSlots: number;
  failedSlots: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastFailureKind?: GenerationFailureKind | null;
  lastFailureCode?: string | null;
  lastFailureMessage?: string | null;
};

export type GenerationSlotRunDto = {
  runId: string;
  slotIndex: number;
  status: GenerationSlotStage;
  currentStage?: GenerationSlotStage | null;
  attemptCount: number;
  startedAt?: string | null;
  endedAt?: string | null;
  lastFailureKind?: GenerationFailureKind | null;
  lastFailureCode?: string | null;
  lastFailureMessage?: string | null;
  title?: string | null;
  topic?: string | null;
  language?: GenerationLanguage | null;
};

export type ValidatedExecutionBundleSummaryDto = {
  language: GenerationLanguage;
  bundleHash: string;
  artifactHashes: {
    starter?: string;
    reference?: string;
    tests?: string;
    description?: string;
  };
  staticFindings: Array<{ code: string; severity: "info" | "warn" | "error"; message: string }>;
  riskScore: number;
  budgetProfile: Record<string, unknown>;
};

export type GenerationProgressEvent =
  | { type: "generation_started"; runId?: string; totalSlots: number; totalProblems?: number; run?: number }
  | { type: "generation_run_status"; runId?: string; status: GenerationRunStatus; activityId?: string; error?: string }
  | {
      runId?: string;
      type: "route_selected";
      slotIndex: number;
      routeRole: LlmRole;
      provider?: string;
      model?: string;
      capability?: string;
      promptTemplateId?: string;
    }
  | {
      runId?: string;
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
      runId?: string;
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
      runId?: string;
      type: "slot_escalated";
      slotIndex: number;
      stage: "tests" | "reference" | "repair";
      routeRole: LlmRole;
      fromModel?: string;
      toModel?: string;
      reason: string;
    }
  | {
      runId?: string;
      type: "slot_failed_terminal";
      slotIndex: number;
      stage: "skeleton" | "tests" | "reference" | "validate" | "repair";
      routeRole?: LlmRole;
      failureKind: GenerationFailureKind;
      terminationReason: string;
      message: string;
    }
  | {
      runId?: string;
      type: "slot_started";
      slotIndex: number;
      difficulty: Difficulty;
      topic: string;
      language: GenerationLanguage;
    }
  | { runId?: string; type: "slot_llm_attempt_started"; slotIndex: number; attempt: number }
  | { runId?: string; type: "slot_contract_validated"; slotIndex: number; attempt: number }
  | {
      runId?: string;
      type: "slot_evidence";
      slotIndex: number;
      attempt: number;
      obligations?: Array<{ id: string; ok: boolean; message?: string }>;
      qualityGate?: { baselines: Array<{ id: string; ok: boolean }> };
      rewrites?: Array<{ id: string; applied: boolean; detail?: string }>;
    }
  | { runId?: string; type: "slot_contract_failed"; slotIndex: number; attempt: number; shortError: string }
  | { runId?: string; type: "slot_docker_validation_started"; slotIndex: number; attempt: number }
  | { runId?: string; type: "slot_docker_validation_failed"; slotIndex: number; attempt: number; shortError: string }
  | {
      runId?: string;
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
      runId?: string;
      type: "slot_failure_diagnostic";
      slotIndex: number;
      attempt: number;
      kind: GenerationFailureKind;
      message: string;
      remediation: string[];
      final: boolean;
    }
  | {
      runId?: string;
      type: "slot_repair_applied";
      slotIndex: number;
      attempt: number;
      strategy: RepairStrategy;
      detail?: string;
    }
  | { runId?: string; type: "slot_completed"; slotIndex: number }
  | { runId?: string; type: "generation_completed"; activityId: string }
  | { runId?: string; type: "generation_failed"; error: string; slotIndex?: number }
  | { runId?: string; type: "generation_soft_fallback_applied"; reason: string; patchPaths: string[] }
  | { runId?: string; type: "heartbeat"; ts: string }
  | { runId?: string; type: "problem_started"; index: number; difficulty: Difficulty }
  | { runId?: string; type: "attempt_started"; index: number; attempt: number }
  | { runId?: string; type: "validation_started"; index: number; attempt: number }
  | { runId?: string; type: "validation_failed"; index: number; attempt: number }
  | { runId?: string; type: "attempt_failed"; index: number; attempt: number; phase: "generate" | "validate" }
  | { runId?: string; type: "problem_validated"; index: number }
  | { runId?: string; type: "problem_failed"; index: number }
  | { runId?: string; type: "generation_complete"; activityId: string };
