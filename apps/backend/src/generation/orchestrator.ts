import type { ProblemPlan } from "../planner/types";
import type { GeneratedProblem } from "../contracts/problem";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import { trace } from "../utils/trace";
import { deriveSlotObligations } from "./obligations";
import { runSlotPipeline, SlotPipelineTerminalError } from "../pipeline/slotStages";
import { applyGuidedScaffoldingAsync } from "./services/scaffoldingService";
import {
  buildArtifactSet,
  buildSlotIntent,
  discardReferenceArtifacts,
} from "./services/normalizationService";
import {
  inferFailureKind,
  progressSummaryForFailure,
} from "./services/validationService";
import type { SlotPromptContext } from "../languages/types";
import type { SlotExecutionFailure, SlotExecutionResult } from "../services/threads/generationState";

const DOMAIN_POOL = [
  "smart home",
  "music streaming",
  "food delivery",
  "event ticketing",
  "fitness tracking",
  "space mission control",
  "hotel booking",
  "ride sharing",
  "online marketplace",
  "photo organizer",
  "recipe planner",
  "study planner",
  "inventory management",
  "movie recommendations",
  "package shipping",
  "language learning",
  "restaurant reservations",
  "weather alerts",
  "customer support",
  "game matchmaking",
] as const;

function hashToIndex(seed: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % modulo;
}

function pickDomain(seed: string, usedDomains: string[]): string {
  const start = hashToIndex(seed, DOMAIN_POOL.length);
  for (let offset = 0; offset < DOMAIN_POOL.length; offset++) {
    const candidate = DOMAIN_POOL[(start + offset) % DOMAIN_POOL.length]!;
    if (!usedDomains.includes(candidate)) return candidate;
  }
  return DOMAIN_POOL[start]!;
}

function isHardFailureKind(kind: string): boolean {
  return kind === "infra" || kind === "judge_infra_failure" || kind === "spec_error" || kind === "run_policy_failure";
}

function resolveSlotConcurrency(explicit?: number | null): number {
  const raw =
    typeof explicit === "number" && Number.isFinite(explicit)
      ? explicit
      : Number.parseInt(process.env.CODEMM_GENERATION_SLOT_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(4, Math.trunc(raw)));
}

function buildProblemMapFromResume(
  problems: GeneratedProblem[],
  outcomes: GenerationOutcome[],
): Map<number, GeneratedProblem> {
  const bySlot = new Map<number, GeneratedProblem>();
  let problemCursor = 0;
  for (const outcome of outcomes) {
    if (!outcome?.success) continue;
    const problem = problems[problemCursor];
    if (problem) {
      bySlot.set(outcome.slotIndex, problem);
      problemCursor += 1;
    }
  }
  return bySlot;
}

function synthesizeFailureStage(status: GenerationOutcome["status"]): SlotExecutionFailure["stage"] {
  if (status === "QUARANTINED") return "FAILURE_DIAGNOSED";
  if (status === "HARD_FAILURE" || status === "FATAL_FAILED") return "QUALITY_GATE_RUNNING";
  if (status === "SKIPPED") return "EXECUTION_BUNDLE_READY";
  return "VALIDATING_REFERENCE";
}

function synthesizeResultFromOutcome(
  outcome: GenerationOutcome,
  problem: GeneratedProblem | undefined,
): SlotExecutionResult {
  if (outcome.success && problem) {
    return {
      slotIndex: outcome.slotIndex,
      terminalStatus: "SUCCEEDED",
      retries: outcome.retries,
      problem,
      outcome,
      title: problem.title,
    };
  }

  const terminalStatus =
    outcome.status === "QUARANTINED" || outcome.status === "SKIPPED"
      ? outcome.status
      : outcome.status === "HARD_FAILURE" || outcome.status === "FATAL_FAILED"
        ? "HARD_FAILURE"
        : "RETRYABLE_FAILURE";

  return {
    slotIndex: outcome.slotIndex,
    terminalStatus,
    retries: outcome.retries,
    outcome,
    failure: {
      kind: outcome.failureKind ?? "unknown",
      code: outcome.failureCode ?? "RESUMED_SLOT_FAILURE",
      message: outcome.message ?? "Slot did not complete successfully.",
      stage: synthesizeFailureStage(outcome.status),
    },
  };
}

async function runSlotGenerationStep(args: {
  slot: ProblemPlan[number];
  onProgress?: (event: GenerationProgressEvent) => void;
  customInstructionsMd?: string;
  promptContext?: SlotPromptContext;
  deps?: {
    runSlotPipeline?: typeof runSlotPipeline;
  };
}): Promise<SlotExecutionResult> {
  const { slot } = args;
  const slotIntent = buildSlotIntent(slot);
  const domainSeed =
    args.promptContext?.domain ??
    pickDomain(`${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`, []);
  const promptContext: SlotPromptContext =
    args.promptContext ??
    ({
      domain: domainSeed,
      avoidDomains: [],
      avoidTitles: [],
      ...(args.customInstructionsMd ? { customInstructionsMd: args.customInstructionsMd } : {}),
    } satisfies SlotPromptContext);

  const topic = slot.topics[0] ?? "topic";
  args.onProgress?.({
    type: "slot_started",
    slotIndex: slot.index,
    difficulty: slot.difficulty,
    topic,
    language: slot.language,
  });
  args.onProgress?.({ type: "problem_started", index: slot.index, difficulty: slot.difficulty });
  trace("generation.slot.plan", {
    slotIndex: slot.index,
    difficulty: slot.difficulty,
    topics: slot.topics,
    language: slot.language,
    problemStyle: slot.problem_style,
    domain: domainSeed,
  });

  try {
    const pipelineRunner = args.deps?.runSlotPipeline ?? runSlotPipeline;
    const generatedResult = {
      generated: await pipelineRunner({
        slot,
        promptContext,
        ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      }),
      attempt: 1,
    };

    const { generated, attempt: finalAttempt } = generatedResult;
    if (slot.pedagogy && !generated.draft.pedagogy) {
      generated.draft = {
        ...(await applyGuidedScaffoldingAsync(generated.draft, slot)),
        pedagogy: slot.pedagogy,
      };
    }
    const problem = discardReferenceArtifacts(generated.draft);
    args.onProgress?.({
      type: "slot_attempt_summary",
      slotIndex: slot.index,
      attempt: finalAttempt,
      maxAttempts: 3,
      phase: "complete",
      status: "success",
      ...(typeof generated.meta.llmOutputHash === "string" ? { llmOutputHash: generated.meta.llmOutputHash } : {}),
      ...(generated.meta.llm ? { llm: generated.meta.llm } : {}),
      slotIntent,
      artifactSet: buildArtifactSet(generated.draft),
    });
    args.onProgress?.({
      type: "slot_evidence",
      slotIndex: slot.index,
      attempt: 1,
      obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
    });
    args.onProgress?.({ type: "slot_completed", slotIndex: slot.index });
    args.onProgress?.({ type: "problem_validated", index: slot.index });
    const outcome: GenerationOutcome = {
      slotIndex: slot.index,
      success: true,
      status: "SUCCEEDED",
      retries: Math.max(0, finalAttempt - 1),
    };
    const result: SlotExecutionResult = {
      slotIndex: slot.index,
      terminalStatus: "SUCCEEDED",
      retries: outcome.retries,
      problem,
      outcome,
      title: problem.title,
    };
    trace("generation.attempt.success", { slotIndex: slot.index, title: generated.draft.title });
    return result;
  } catch (err: any) {
    console.warn(`Slot ${slot.index} staged pipeline failed:`, err?.message ?? err);
    const finalKind = err instanceof SlotPipelineTerminalError ? err.kind : inferFailureKind(err);
    const emitted = progressSummaryForFailure({
      slotIndex: slot.index,
      attempt: 1,
      maxAttempts: 3,
      err,
      ...(typeof err?.llmOutputHash === "string" ? { llmOutputHash: err.llmOutputHash } : {}),
      ...(err?.llm ? { llm: err.llm } : {}),
      slotIntent,
      final: true,
    });
    args.onProgress?.(emitted.summary);
    args.onProgress?.(emitted.failure);
    args.onProgress?.({
      type: "slot_failed_terminal",
      slotIndex: slot.index,
      stage: err instanceof SlotPipelineTerminalError ? err.stage : "reference",
      ...(err?.routeRole ? { routeRole: err.routeRole } : {}),
      failureKind: finalKind,
      terminationReason: err instanceof SlotPipelineTerminalError ? err.stage : "slot_pipeline",
      message: err instanceof Error ? err.message : String(err),
    });
    args.onProgress?.({ type: "problem_failed", index: slot.index });
    const failOutcome: GenerationOutcome = {
      slotIndex: slot.index,
      success: false,
      retries: 0,
      status: finalKind === "repair_no_progress" ? "QUARANTINED" : isHardFailureKind(finalKind) ? "HARD_FAILURE" : "RETRYABLE_FAILURE",
      failureKind: finalKind,
      failureCode: err instanceof SlotPipelineTerminalError ? `STAGE_${err.stage.toUpperCase()}` : "SLOT_PIPELINE_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
    const failure: SlotExecutionFailure = {
      kind: finalKind,
      code: err instanceof SlotPipelineTerminalError ? `STAGE_${err.stage.toUpperCase()}` : "SLOT_PIPELINE_FAILED",
      message: err instanceof Error ? err.message : String(err),
      stage:
        err instanceof SlotPipelineTerminalError
          ? err.stage === "validate"
            ? "VALIDATING_REFERENCE"
            : err.stage === "repair"
              ? "REPAIRING_REFERENCE"
              : err.stage === "reference"
                ? "REFERENCE_RUNNING"
                : err.stage === "tests"
                  ? "TESTS_RUNNING"
                  : "SKELETON_RUNNING"
          : "HARD_FAILURE",
      ...(typeof err?.title === "string" ? { title: err.title } : {}),
      ...(typeof err?.llmOutputHash === "string" ? { llmOutputHash: err.llmOutputHash } : {}),
    };
    const terminalStatus =
      failOutcome.status === "HARD_FAILURE"
        ? "HARD_FAILURE"
        : failOutcome.status === "QUARANTINED"
          ? "QUARANTINED"
          : "RETRYABLE_FAILURE";
    const result: SlotExecutionResult = {
      slotIndex: slot.index,
      terminalStatus,
      retries: 0,
      outcome: failOutcome,
      failure,
      ...(typeof err?.title === "string" ? { title: err.title } : {}),
    };
    return result;
  }
}

function buildPromptContextForSlot(args: {
  slot: ProblemPlan[number];
  assignedDomains: Map<number, string>;
  priorSuccessfulTitles: string[];
  customInstructionsMd?: string;
}): SlotPromptContext {
  const priorDomains = [...args.assignedDomains.entries()]
    .filter(([slotIndex]) => slotIndex < args.slot.index)
    .sort((a, b) => a[0] - b[0])
    .map(([, domain]) => domain);

  return {
    domain: args.assignedDomains.get(args.slot.index) ?? pickDomain(
      `${args.slot.language}:${args.slot.difficulty}:${args.slot.topics.join(",")}:${args.slot.index}`,
      priorDomains
    ),
    avoidDomains: priorDomains.slice(-4),
    avoidTitles: args.priorSuccessfulTitles.slice(-4),
    ...(args.customInstructionsMd ? { customInstructionsMd: args.customInstructionsMd } : {}),
  };
}

function buildOrderedSnapshot(args: {
  plan: ProblemPlan;
  resultBySlot: Map<number, SlotExecutionResult>;
}): { problems: GeneratedProblem[]; outcomes: GenerationOutcome[]; slotResults: SlotExecutionResult[] } {
  const ordered = args.plan
    .map((slot) => args.resultBySlot.get(slot.index))
    .filter((result): result is SlotExecutionResult => Boolean(result));

  const outcomes = ordered.map((result) => result.outcome);
  const problems = ordered
    .filter((result): result is Extract<SlotExecutionResult, { terminalStatus: "SUCCEEDED" }> => result.terminalStatus === "SUCCEEDED")
    .map((result) => result.problem);

  return { problems, outcomes, slotResults: ordered };
}

export async function generateProblemsFromPlan(
  plan: ProblemPlan,
  opts?: {
    onProgress?: (event: GenerationProgressEvent) => void;
    customInstructionsMd?: string | null;
    resume?: { problems: GeneratedProblem[]; outcomes: GenerationOutcome[] };
    targetSlotIndexes?: number[];
    concurrency?: number;
    onCheckpoint?: (state: {
      problems: GeneratedProblem[];
      outcomes: GenerationOutcome[];
      completedSlotIndex: number;
    }) => void;
    deps?: {
      runSlotPipeline?: typeof runSlotPipeline;
    };
  }
): Promise<{ problems: GeneratedProblem[]; outcomes: GenerationOutcome[]; slotResults: SlotExecutionResult[] }> {
  const resumeProblems = Array.isArray(opts?.resume?.problems) ? opts.resume!.problems : [];
  const resumeOutcomes = Array.isArray(opts?.resume?.outcomes) ? opts.resume!.outcomes : [];
  const initialCount =
    resumeProblems.length === resumeOutcomes.length && resumeProblems.length <= plan.length
      ? resumeProblems.length
      : 0;
  const onProgress = opts?.onProgress;
  const onCheckpoint = opts?.onCheckpoint;
  const customInstructionsMd = (() => {
    const raw = typeof opts?.customInstructionsMd === "string" ? opts.customInstructionsMd : "";
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const maxLen = 8000;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…(truncated)` : trimmed;
  })();
  const resultBySlot = new Map<number, SlotExecutionResult>();
  const resumeProblemBySlot = buildProblemMapFromResume(resumeProblems, resumeOutcomes);
  const targetSlotIndexes = (() => {
    const explicit = Array.isArray(opts?.targetSlotIndexes)
      ? [...new Set(opts!.targetSlotIndexes.filter((value) => Number.isInteger(value) && value >= 0 && value < plan.length))].sort((a, b) => a - b)
      : null;
    if (explicit && explicit.length > 0) return explicit;
    if (initialCount > 0) return plan.slice(initialCount).map((slot) => slot.index);
    return plan.map((slot) => slot.index);
  })();
  const targetSlotIndexSet = new Set(targetSlotIndexes);

  for (const outcome of resumeOutcomes) {
    if (targetSlotIndexSet.has(outcome.slotIndex)) continue;
    const synthesized = synthesizeResultFromOutcome(outcome, resumeProblemBySlot.get(outcome.slotIndex));
    resultBySlot.set(outcome.slotIndex, synthesized);
  }

  const assignedDomains = new Map<number, string>();
  for (const slot of plan) {
    const priorDomains = [...assignedDomains.values()];
    assignedDomains.set(
      slot.index,
      pickDomain(`${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`, priorDomains),
    );
  }

  const priorSuccessfulTitles = plan
    .map((slot) => resumeProblemBySlot.get(slot.index))
    .filter((problem): problem is GeneratedProblem => Boolean(problem))
    .map((problem) => problem.title)
    .filter((title): title is string => typeof title === "string" && title.trim().length > 0);

  const slotsToRun = plan.filter((slot) => targetSlotIndexSet.has(slot.index));
  const concurrency = Math.min(resolveSlotConcurrency(opts?.concurrency ?? null), Math.max(1, slotsToRun.length || 1));
  trace("generation.orchestrator.schedule", {
    totalSlots: plan.length,
    targetSlotIndexes,
    concurrency,
  });

  let cursor = 0;
  async function worker() {
    while (cursor < slotsToRun.length) {
      const next = slotsToRun[cursor];
      cursor += 1;
      if (!next) continue;

      const result = await runSlotGenerationStep({
        slot: next,
        ...(onProgress ? { onProgress } : {}),
        ...(customInstructionsMd ? { customInstructionsMd } : {}),
        promptContext: buildPromptContextForSlot({
          slot: next,
          assignedDomains,
          priorSuccessfulTitles,
          ...(customInstructionsMd ? { customInstructionsMd } : {}),
        }),
        ...(opts?.deps ? { deps: opts.deps } : {}),
      });
      resultBySlot.set(next.index, result);

      if (onCheckpoint) {
        const snapshot = buildOrderedSnapshot({ plan, resultBySlot });
        onCheckpoint({
          problems: snapshot.problems,
          outcomes: snapshot.outcomes,
          completedSlotIndex: next.index,
        });
      }
    }
  }

  if (slotsToRun.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  return buildOrderedSnapshot({ plan, resultBySlot });
}
