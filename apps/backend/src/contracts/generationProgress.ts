import type { Difficulty } from "./activitySpec";
import type { AttemptDiagnostic, RepairStrategy } from "./generationDiagnostics";
import type { GenerationFailureKind } from "../generation/errors";
import type { LlmRole } from "../infra/llm/types";

export type GenerationProgressEvent =
  // Phase 2B: richer structured events for per-slot progress UI.
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
      language: "java" | "python" | "cpp" | "sql";
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
      phase: AttemptDiagnostic["phase"];
      status: AttemptDiagnostic["status"];
      kind?: GenerationFailureKind;
      message?: string;
      remediation?: string[];
      llmOutputHash?: string;
      llm?: AttemptDiagnostic["llm"];
      slotIntent?: AttemptDiagnostic["slotIntent"];
      artifactSet?: AttemptDiagnostic["artifactSet"];
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
  // Backwards-compatible v1 events (older frontend clients).
  | { type: "problem_started"; index: number; difficulty: Difficulty }
  | { type: "attempt_started"; index: number; attempt: number }
  | { type: "validation_started"; index: number; attempt: number }
  | { type: "validation_failed"; index: number; attempt: number }
  | { type: "attempt_failed"; index: number; attempt: number; phase: "generate" | "validate" }
  | { type: "problem_validated"; index: number }
  | { type: "problem_failed"; index: number }
  | { type: "generation_complete"; activityId: string };
