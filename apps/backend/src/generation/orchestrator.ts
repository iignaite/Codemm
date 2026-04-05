import type { ProblemPlan } from "../planner/types";
import type { GeneratedProblem } from "../contracts/problem";
import type { GenerationOutcome } from "../contracts/generationOutcome";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import { trace } from "../utils/trace";
import { GenerationSlotFailureError } from "./errors";
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
): Promise<{ problems: GeneratedProblem[]; outcomes: GenerationOutcome[] }> {
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

  for (const slot of plan.slice(initialCount)) {
    const slotIntent = buildSlotIntent(slot);
    const domainSeed = pickDomain(
      `${slot.language}:${slot.difficulty}:${slot.topics.join(",")}:${slot.index}`,
      usedDomains
    );
    const promptContext: SlotPromptContext = {
      domain: domainSeed,
      avoidDomains: usedDomains.slice(-4),
      avoidTitles: usedTitles.slice(-4),
      ...(customInstructionsMd ? { customInstructionsMd } : {}),
    };

    const topic = slot.topics[0] ?? "topic";
    onProgress?.({
      type: "slot_started",
      slotIndex: slot.index,
      difficulty: slot.difficulty,
      topic,
      language: slot.language,
    });
    onProgress?.({ type: "problem_started", index: slot.index, difficulty: slot.difficulty });
    trace("generation.slot.plan", {
      slotIndex: slot.index,
      difficulty: slot.difficulty,
      topics: slot.topics,
      language: slot.language,
      problemStyle: slot.problem_style,
      domain: domainSeed,
    });

    try {
      const generatedResult = useLegacyAdapter
        ? await runLegacySlotAdapter({
            slot,
            promptContext,
            slotIntent,
            ...(onProgress ? { onProgress } : {}),
            ...(opts?.deps ? { deps: opts.deps } : {}),
          })
        : {
            generated: await runSlotPipeline({
              slot,
              promptContext,
              ...(onProgress ? { onProgress } : {}),
            }),
            attempt: 1,
          };

      const { generated, attempt: finalAttempt } = generatedResult;
      if (useLegacyAdapter && slot.pedagogy) {
        generated.draft = {
          ...(await applyGuidedScaffoldingAsync(generated.draft, slot)),
          pedagogy: slot.pedagogy,
        };
      }
      const problem = discardReferenceArtifacts(generated.draft);
      onProgress?.({
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
      if (!useLegacyAdapter) {
        onProgress?.({
          type: "slot_evidence",
          slotIndex: slot.index,
          attempt: 1,
          obligations: deriveSlotObligations(slot).map((id) => ({ id, ok: true })),
        });
      }
      onProgress?.({ type: "slot_completed", slotIndex: slot.index });
      onProgress?.({ type: "problem_validated", index: slot.index });
      problems.push(problem);
      outcomes.push({ slotIndex: slot.index, success: true, retries: Math.max(0, finalAttempt - 1) });
      trace("generation.attempt.success", { slotIndex: slot.index, title: generated.draft.title });
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
      onProgress?.(emitted.summary);
      onProgress?.(emitted.failure);
      onProgress?.({
        type: "slot_failed_terminal",
        slotIndex: slot.index,
        stage: err instanceof SlotPipelineTerminalError ? err.stage : "reference",
        ...(err?.routeRole ? { routeRole: err.routeRole } : {}),
        failureKind: finalKind,
        terminationReason: err instanceof SlotPipelineTerminalError ? err.stage : "slot_pipeline",
        message: err instanceof Error ? err.message : String(err),
      });
      onProgress?.({ type: "problem_failed", index: slot.index });
      const failOutcome: GenerationOutcome = {
        slotIndex: slot.index,
        success: false,
        retries: 0,
      };
      throw new GenerationSlotFailureError(
        `Failed to generate slot ${slot.index}. Last error: ${err instanceof Error ? err.message : String(err)}`,
        {
          slotIndex: slot.index,
          kind: finalKind,
          attempts: 1,
          ...(typeof err?.title === "string" ? { title: err.title } : {}),
          ...(typeof err?.llmOutputHash === "string" ? { llmOutputHash: err.llmOutputHash } : {}),
          ...(err?.llm ? { llm: err.llm } : {}),
          outcomesSoFar: [...outcomes, failOutcome],
          problemsSoFar: [...problems],
        }
      );
    }

    usedDomains.push(domainSeed);
    usedTitles.push(problems[problems.length - 1]!.title);
    onCheckpoint?.({ problems, outcomes, completedSlotIndex: slot.index });
  }

  return { problems, outcomes };
}
