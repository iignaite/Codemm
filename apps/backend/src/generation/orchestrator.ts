import type { ProblemPlan } from "../planner/types";
import type { GeneratedProblem } from "../contracts/problem";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import { createExecutionContext } from "../engine/execution/ExecutionContext";
import { ExecutionEngine } from "../engine/execution/ExecutionEngine";
import type { Step } from "../engine/execution/Step";
import { trace } from "../utils/trace";
import { deriveSlotObligations } from "./obligations";
import { runSlotPipeline, SlotPipelineTerminalError } from "../pipeline/slotStages";
import { applyGuidedScaffoldingAsync } from "./services/scaffoldingService";
import { runLegacySlotAdapter } from "./legacyAdapter";
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

type OrchestratorState = {
  problems: GeneratedProblem[];
  outcomes: GenerationOutcome[];
  slotResults: SlotExecutionResult[];
  usedDomains: string[];
  usedTitles: string[];
};

async function runSlotGenerationStep(args: {
  slot: ProblemPlan[number];
  state: OrchestratorState;
  onProgress?: (event: GenerationProgressEvent) => void;
  onCheckpoint?: (state: {
    problems: GeneratedProblem[];
    outcomes: GenerationOutcome[];
    completedSlotIndex: number;
  }) => void;
  customInstructionsMd?: string;
  useLegacyAdapter: boolean;
  deps?: {
    generateSingleProblem?: (...args: any[]) => Promise<any>;
    validateReferenceSolution?: (...args: any[]) => Promise<any>;
    runTestStrengthGate?: (...args: any[]) => Promise<any>;
  };
}): Promise<SlotExecutionResult> {
  const { slot } = args;
  const slotIntent = buildSlotIntent(slot);
  const domainSeed = pickDomain(
    `${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`,
    args.state.usedDomains
  );
  const promptContext: SlotPromptContext = {
    domain: domainSeed,
    avoidDomains: args.state.usedDomains.slice(-4),
    avoidTitles: args.state.usedTitles.slice(-4),
    ...(args.customInstructionsMd ? { customInstructionsMd: args.customInstructionsMd } : {}),
  };

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
    const generatedResult = args.useLegacyAdapter
      ? await runLegacySlotAdapter({
          slot,
          promptContext,
          slotIntent,
          ...(args.onProgress ? { onProgress: args.onProgress } : {}),
          ...(args.deps ? { deps: args.deps } : {}),
        })
      : {
          generated: await runSlotPipeline({
            slot,
            promptContext,
            ...(args.onProgress ? { onProgress: args.onProgress } : {}),
          }),
          attempt: 1,
        };

    const { generated, attempt: finalAttempt } = generatedResult;
    if (args.useLegacyAdapter && slot.pedagogy) {
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
    if (!args.useLegacyAdapter) {
      args.onProgress?.({
        type: "slot_evidence",
        slotIndex: slot.index,
        attempt: 1,
        obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
      });
    }
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
    args.state.problems.push(problem);
    args.state.outcomes.push(outcome);
    args.state.slotResults.push(result);
    args.state.usedDomains.push(domainSeed);
    args.state.usedTitles.push(problem.title);
    args.onCheckpoint?.({ problems: args.state.problems, outcomes: args.state.outcomes, completedSlotIndex: slot.index });
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
      status: finalKind === "infra" ? "HARD_FAILURE" : "RETRYABLE_FAILURE",
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
    const terminalStatus = failOutcome.status === "HARD_FAILURE" ? "HARD_FAILURE" : "RETRYABLE_FAILURE";
    const result: SlotExecutionResult = {
      slotIndex: slot.index,
      terminalStatus,
      retries: 0,
      outcome: failOutcome,
      failure,
      ...(typeof err?.title === "string" ? { title: err.title } : {}),
    };
    args.state.outcomes.push(failOutcome);
    args.state.slotResults.push(result);
    args.onCheckpoint?.({ problems: args.state.problems, outcomes: args.state.outcomes, completedSlotIndex: slot.index });
    return result;
  }
}

export async function generateProblemsFromPlan(
  plan: ProblemPlan,
  opts?: {
    onProgress?: (event: GenerationProgressEvent) => void;
    customInstructionsMd?: string | null;
    resume?: { problems: GeneratedProblem[]; outcomes: GenerationOutcome[] };
    onCheckpoint?: (state: {
      problems: GeneratedProblem[];
      outcomes: GenerationOutcome[];
      completedSlotIndex: number;
    }) => void;
    deps?: {
      generateSingleProblem?: (...args: any[]) => Promise<any>;
      validateReferenceSolution?: (...args: any[]) => Promise<any>;
      runTestStrengthGate?: (...args: any[]) => Promise<any>;
    };
  }
): Promise<{ problems: GeneratedProblem[]; outcomes: GenerationOutcome[]; slotResults: SlotExecutionResult[] }> {
  const resumeProblems = Array.isArray(opts?.resume?.problems) ? opts!.resume!.problems : [];
  const resumeOutcomes = Array.isArray(opts?.resume?.outcomes) ? opts!.resume!.outcomes : [];
  const initialCount =
    resumeProblems.length === resumeOutcomes.length && resumeProblems.length <= plan.length
      ? resumeProblems.length
      : 0;

  const problems: GeneratedProblem[] = initialCount ? [...resumeProblems.slice(0, initialCount)] : [];
  const outcomes: GenerationOutcome[] = initialCount ? [...resumeOutcomes.slice(0, initialCount)] : [];
  const onProgress = opts?.onProgress;
  const onCheckpoint = opts?.onCheckpoint;
  const useLegacyAdapter = typeof opts?.deps?.generateSingleProblem === "function";
  const usedDomains: string[] = [];
  const usedTitles: string[] = [];
  const customInstructionsMd = (() => {
    const raw = typeof opts?.customInstructionsMd === "string" ? opts.customInstructionsMd : "";
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const maxLen = 8000;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…(truncated)` : trimmed;
  })();

  for (let i = 0; i < initialCount; i++) {
    const slot = plan[i];
    if (!slot) continue;
    const domainSeed = pickDomain(`${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`, usedDomains);
    usedDomains.push(domainSeed);
    const title = problems[i]?.title;
    if (typeof title === "string" && title.trim()) usedTitles.push(title);
  }

  const context = createExecutionContext<OrchestratorState, Record<string, never>>({
    workflowId: `generation-plan:${plan.length}:${initialCount}`,
    loggerName: "generation.orchestrator",
    initialState: { problems, outcomes, slotResults: [], usedDomains, usedTitles },
  });
  const steps: Step<OrchestratorState, Record<string, never>>[] = plan.slice(initialCount).map((slot) => ({
    id: `slot:${slot.index}`,
    run: async () => {
      await runSlotGenerationStep({
        slot,
        state: context.state,
        ...(onProgress ? { onProgress } : {}),
        ...(onCheckpoint ? { onCheckpoint } : {}),
        ...(customInstructionsMd ? { customInstructionsMd } : {}),
        useLegacyAdapter,
        ...(opts?.deps ? { deps: opts.deps } : {}),
      });
    },
  }));

  await new ExecutionEngine(steps).run(context);
  return { problems: context.state.problems, outcomes: context.state.outcomes, slotResults: context.state.slotResults };
}
