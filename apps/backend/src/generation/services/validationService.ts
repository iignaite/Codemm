import crypto from "crypto";
import type { ProblemPlan } from "../../planner/types";
import type { GeneratedProblemDraft } from "../../contracts/problem";
import type { AttemptDiagnostic, SlotIntent } from "../../contracts/generationDiagnostics";
import type { CompletionMeta } from "../../infra/llm/types";
import {
  GenerationContractError,
  type GenerationFailureKind,
} from "../errors";
import { getTraceContext } from "../../utils/traceContext";
import {
  generationExecutionAttemptRepository,
  generationRunFailureCacheRepository,
  generationSlotDiagnosisRepository,
} from "../../database/repositories/generationRunRepository";
import type { RepairStrategy } from "@codemm/shared-contracts";
import {
  ReferenceSolutionValidationError,
  validateReferenceSolution,
} from "../referenceSolutionValidator";
import { TestStrengthGateError } from "../testStrengthGate";
import { isValidJUnit5TestSuiteCountRange, pruneJUnitTestMethods } from "../../languages/java/rules";
import { assertJavaStructuralTopicRequirements } from "../../languages/java/structuralTopics";
import {
  buildValidatedExecutionBundle,
  ExecutionBundleValidationError,
  type ValidatedExecutionBundle,
} from "./executionBundle";

export function inferFailureKind(err: unknown): GenerationFailureKind {
  const explicitKind = (err as { kind?: unknown } | null)?.kind;
  if (
    explicitKind === "generation_schema_error" ||
    explicitKind === "static_rule_violation" ||
    explicitKind === "api_shape_mismatch" ||
    explicitKind === "complexity_risk_exceeded" ||
    explicitKind === "compile_failure" ||
    explicitKind === "test_failure" ||
    explicitKind === "time_budget_exceeded" ||
    explicitKind === "output_limit_exceeded" ||
    explicitKind === "judge_infra_failure" ||
    explicitKind === "repair_no_progress" ||
    explicitKind === "run_policy_failure" ||
    explicitKind === "compile" ||
    explicitKind === "tests" ||
    explicitKind === "timeout" ||
    explicitKind === "contract" ||
    explicitKind === "quality" ||
    explicitKind === "llm" ||
    explicitKind === "unknown"
  ) {
    return explicitKind;
  }
  if (err instanceof ExecutionBundleValidationError) return err.kind;
  if (err instanceof ReferenceSolutionValidationError) return err.kind;
  if (err instanceof GenerationContractError) return "contract";
  if (err instanceof TestStrengthGateError) return "quality";
  if (/Invalid test_suite|schema validation|public class|Test suite class name/i.test(String((err as any)?.message))) {
    return "contract";
  }
  return "unknown";
}

export function recommendedRemediation(kind: GenerationFailureKind): string[] {
  if (kind === "generation_schema_error") return ["Regenerate this slot", "Tighten the generation contract"];
  if (kind === "static_rule_violation") return ["Regenerate this slot", "Inject stricter deterministic guardrails"];
  if (kind === "api_shape_mismatch") return ["Regenerate reference shape", "Regenerate test shape"];
  if (kind === "complexity_risk_exceeded") return ["Regenerate simpler logic", "Tighten constraints"];
  if (kind === "compile_failure") return ["Regenerate this slot", "Repair the reference implementation"];
  if (kind === "test_failure") return ["Repair the reference logic", "Regenerate this slot"];
  if (kind === "time_budget_exceeded") return ["Regenerate simpler logic", "Inject bounded-loop guardrails"];
  if (kind === "output_limit_exceeded") return ["Regenerate this slot", "Reduce extraneous output"];
  if (kind === "judge_infra_failure") return ["Retry this slot", "Re-run after judge health recovers"];
  if (kind === "repair_no_progress") return ["Change repair strategy", "Quarantine this slot"];
  if (kind === "run_policy_failure") return ["Adjust run policy", "Retry with a simpler request"];
  if (kind === "compile") return ["Regenerate this slot", "Reduce difficulty for this slot"];
  if (kind === "tests") return ["Regenerate this slot", "Narrow topic scope"];
  if (kind === "timeout") return ["Regenerate this slot", "Reduce constraints and complexity"];
  if (kind === "contract") return ["Regenerate this slot", "Simplify prompt constraints"];
  if (kind === "quality") return ["Regenerate stronger tests", "Reduce requested hardness"];
  if (kind === "llm") return ["Retry this slot", "Switch to a stronger model"];
  return ["Retry this slot", "Narrow topic scope"];
}

export function validateInjectedDraftContract(slot: ProblemPlan[number], draft: GeneratedProblemDraft): void {
  if (draft.language !== slot.language) {
    throw new GenerationContractError(`Invalid language for slot ${slot.index}: must match slot.language exactly.`, {
      slotIndex: slot.index,
    });
  }
  if (draft.constraints !== slot.constraints) {
    throw new GenerationContractError(`Invalid constraints for slot ${slot.index}: must match slot.constraints exactly.`, {
      slotIndex: slot.index,
    });
  }
  if (slot.language === "java" && "reference_solution" in draft && typeof draft.reference_solution === "string") {
    assertJavaStructuralTopicRequirements({
      topics: slot.topics,
      referenceSource: draft.reference_solution,
      testSuite: draft.test_suite,
    });
  }
}

export async function validateDraftArtifacts(draft: GeneratedProblemDraft): Promise<void> {
  await validateReferenceSolution(draft);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function trimSnippet(text: string | undefined, limit: number = 1200): string | null {
  const clean = String(text ?? "");
  if (!clean.trim()) return null;
  return clean.slice(0, limit);
}

export function buildFailureDiagnosis(args: {
  kind: GenerationFailureKind;
  err: unknown;
}): {
  diagnosisClass: string;
  recoverability: "recoverable" | "fatal" | "quarantine";
  normalizedSymptom: string;
  recommendedRepairStrategy: string | null;
} {
  const message = String((args.err as any)?.message ?? "unknown failure");
  const lower = message.toLowerCase();

  if (args.kind === "time_budget_exceeded" || args.kind === "timeout") {
    return {
      diagnosisClass: "timeout_or_nontermination",
      recoverability: "recoverable",
      normalizedSymptom: lower.includes("stdin") ? "stdin_timeout" : "execution_timeout",
      recommendedRepairStrategy: "tighten_constraints",
    };
  }
  if (args.kind === "api_shape_mismatch" || args.kind === "contract") {
    return {
      diagnosisClass: "api_mismatch",
      recoverability: "recoverable",
      normalizedSymptom: lower.includes("stdin") ? "stdin_api_mismatch" : "shape_mismatch",
      recommendedRepairStrategy: "regenerate_reference_shape",
    };
  }
  if (args.kind === "compile_failure" || args.kind === "compile") {
    return {
      diagnosisClass: "compile_breakage",
      recoverability: "recoverable",
      normalizedSymptom: "compile_failure",
      recommendedRepairStrategy: "regenerate_reference_shape",
    };
  }
  if (args.kind === "test_failure" || args.kind === "tests") {
    return {
      diagnosisClass: "logic_bug",
      recoverability: "recoverable",
      normalizedSymptom: lower.includes("baseline") ? "quality_gate_failed" : "reference_failed_tests",
      recommendedRepairStrategy: lower.includes("baseline") ? "regenerate_tests_shape" : "regenerate_reference_logic",
    };
  }
  if (args.kind === "quality") {
    return {
      diagnosisClass: "quality_gate_weak_tests",
      recoverability: "recoverable",
      normalizedSymptom: "weak_test_suite",
      recommendedRepairStrategy: "regenerate_tests_shape",
    };
  }
  if (args.kind === "repair_no_progress") {
    return {
      diagnosisClass: "repair_no_progress",
      recoverability: "quarantine",
      normalizedSymptom: "repair_no_progress",
      recommendedRepairStrategy: "quarantine_slot",
    };
  }
  if (args.kind === "judge_infra_failure" || args.kind === "infra") {
    return {
      diagnosisClass: "judge_infra_failure",
      recoverability: "recoverable",
      normalizedSymptom: "judge_infra_failure",
      recommendedRepairStrategy: "inject_guardrails",
    };
  }
  return {
    diagnosisClass: "logic_bug",
    recoverability: "recoverable",
    normalizedSymptom: "generic_generation_failure",
    recommendedRepairStrategy: "regenerate_reference_logic",
  };
}

export function persistExecutionAttempt(args: {
  slotIndex: number;
  attempt: number;
  executionPhase: "compile" | "test_exec" | "quality_gate";
  bundle: Pick<ValidatedExecutionBundle, "bundleHash" | "executionBudgetProfile">;
  strategy?: string | null;
  result?: {
    startedAt: string;
    finishedAt?: string | null;
    exitCode?: number | null;
    timeoutStage?: "compile" | "execute" | "overall" | null;
    watchdogSource?: "inner" | "outer" | "unknown" | null;
    failureCategory?: string | null;
    stdout?: string;
    stderr?: string;
    parsedFailures?: unknown;
    trace?: unknown;
  };
}): number | null {
  const ctx = getTraceContext();
  if (!ctx?.runId) return null;
  return generationExecutionAttemptRepository.create({
    runId: ctx.runId,
    slotIndex: args.slotIndex,
    attempt: args.attempt,
    executionPhase: args.executionPhase,
    bundleHash: args.bundle.bundleHash,
    strategy: args.strategy ?? null,
    budgetProfile: args.bundle.executionBudgetProfile,
    startedAt: args.result?.startedAt ?? new Date().toISOString(),
    finishedAt: args.result?.finishedAt ?? new Date().toISOString(),
    exitCode: args.result?.exitCode ?? null,
    timeoutStage: args.result?.timeoutStage ?? null,
    watchdogSource: args.result?.watchdogSource ?? null,
    failureCategory: args.result?.failureCategory ?? null,
    stdoutHash: args.result?.stdout ? sha256(args.result.stdout) : null,
    stderrHash: args.result?.stderr ? sha256(args.result.stderr) : null,
    stdoutSnippet: trimSnippet(args.result?.stdout),
    stderrSnippet: trimSnippet(args.result?.stderr),
    parsedFailures: args.result?.parsedFailures,
    trace: args.result?.trace,
  });
}

export function persistFailureDiagnosis(args: {
  slot: ProblemPlan[number];
  attempt: number;
  kind: GenerationFailureKind;
  err: unknown;
  sourceExecutionAttemptId?: number | null;
}): void {
  const ctx = getTraceContext();
  if (!ctx?.runId) return;
  const diagnosis = buildFailureDiagnosis({ kind: args.kind, err: args.err });
  generationSlotDiagnosisRepository.create({
    runId: ctx.runId,
    slotIndex: args.slot.index,
    attempt: args.attempt,
    diagnosisClass: diagnosis.diagnosisClass,
    recoverability: diagnosis.recoverability,
    normalizedSymptom: diagnosis.normalizedSymptom,
    recommendedRepairStrategy: diagnosis.recommendedRepairStrategy,
    sourceExecutionAttemptId: args.sourceExecutionAttemptId ?? null,
  });
  generationRunFailureCacheRepository.create({
    runId: ctx.runId,
    language: args.slot.language,
    topicSignature: [...args.slot.topics].sort().join("|"),
    failureClass: args.kind,
    normalizedSymptom: diagnosis.normalizedSymptom,
    guardrailPatch:
      diagnosis.normalizedSymptom === "stdin_timeout" || diagnosis.normalizedSymptom === "stdin_api_mismatch"
        ? { injectGuardrails: ["No stdin reads", "Use pure deterministic methods", "Bound loops and recursion"] }
        : { injectGuardrails: ["Keep solutions deterministic", "Avoid brittle edge-case assumptions"] },
  });
}

export function prepareValidatedExecutionBundle(args: {
  slot: ProblemPlan[number];
  draft: GeneratedProblemDraft;
  repairStrategy?: RepairStrategy | null;
  llmOutputHash?: string | null;
}): ValidatedExecutionBundle {
  return buildValidatedExecutionBundle({
    slot: args.slot,
    draft: args.draft,
    repairStrategy: args.repairStrategy ?? null,
    llmOutputHash: args.llmOutputHash ?? null,
  });
}

export function progressSummaryForFailure(args: {
  slotIndex: number;
  attempt: number;
  maxAttempts: number;
  err: unknown;
  llmOutputHash?: string;
  llm?: CompletionMeta;
  slotIntent: SlotIntent;
  final: boolean;
}) {
  const kind = inferFailureKind(args.err);
  const message = String((args.err as any)?.message ?? "Unknown generation failure");
  const phase: AttemptDiagnostic["phase"] =
    args.err instanceof ReferenceSolutionValidationError
      ? "validate"
      : args.err instanceof TestStrengthGateError
        ? "quality"
        : "generate";
  return {
    summary: {
      type: "slot_attempt_summary" as const,
      slotIndex: args.slotIndex,
      attempt: args.attempt,
      maxAttempts: args.maxAttempts,
      phase,
      status: "failed" as const,
      kind,
      message: message.slice(0, 360),
      remediation: recommendedRemediation(kind),
      ...(typeof args.llmOutputHash === "string" ? { llmOutputHash: args.llmOutputHash } : {}),
      ...(args.llm ? { llm: args.llm } : {}),
      slotIntent: args.slotIntent,
    },
    failure: {
      type: "slot_failure_diagnostic" as const,
      slotIndex: args.slotIndex,
      attempt: args.attempt,
      kind,
      message: message.slice(0, 360),
      remediation: recommendedRemediation(kind),
      final: args.final,
    },
  };
}

export function tryDropFailingJavaTests(
  draft: GeneratedProblemDraft,
  err: ReferenceSolutionValidationError
): { draft: GeneratedProblemDraft; droppedTests: string[] } | null {
  if (draft.language !== "java") return null;
  if (!("test_suite" in draft) || typeof draft.test_suite !== "string") return null;

  const failedTests = extractFailedJavaTestNames(`${err.judgeStdout ?? ""}\n${err.judgeStderr ?? ""}`);
  if (failedTests.length === 0) return null;

  const pruned = pruneJUnitTestMethods(draft.test_suite, failedTests);
  if (pruned.dropped.length === 0) return null;
  if (!isValidJUnit5TestSuiteCountRange(pruned.testSuite, 1, 8)) return null;

  return {
    draft: { ...draft, test_suite: pruned.testSuite },
    droppedTests: pruned.dropped,
  };
}

function extractFailedJavaTestNames(output: string): string[] {
  const clean = String(output ?? "");
  const names = new Set<string>();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\(\)\s+\[X\]\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}
