import crypto from "crypto";
import { ActivitySpecSchema, type ActivitySpec } from "../../contracts/activitySpec";
import { isLanguageSupportedForGeneration } from "../../languages/profiles";
import { deriveProblemPlan } from "../../planner";
import { buildGuidedPedagogyPolicy } from "../../planner/pedagogy";
import { generateProblemsFromPlan } from "../../generation";
import type { GeneratedProblem } from "../../contracts/problem";
import type { GenerationOutcome } from "../../contracts/generationOutcome";
import type { GenerationProgressEvent } from "../../contracts/generationProgress";
import { GenerationSlotFailureError } from "../../generation/errors";
import { publishGenerationProgress } from "../../generation/progressBus";
import { applyJsonPatch } from "../../compiler/jsonPatch";
import { proposeGenerationFallbackWithPolicy } from "../../agent/generationFallback";
import { trace } from "../../utils/trace";
import { withTraceContext } from "../../utils/traceContext";
import { activityRepository } from "../../database/repositories/activityRepository";
import { threadRepository } from "../../database/repositories/threadRepository";
import {
  appendIntentTrace,
  mergeConfidence,
  parseGeneratedProblems,
  parseGenerationOutcomes,
  parseJsonArray,
  parseJsonObject,
  parseLearningMode,
  parseSpecJson,
  requireSession,
  transitionOrThrow,
} from "./shared";
import { parseCommitmentsJson } from "../../agent/commitments";

export type GenerateFromSessionResponse = {
  activityId: string;
  problems: GeneratedProblem[];
};

export async function generateFromSession(sessionId: string): Promise<GenerateFromSessionResponse> {
  return withTraceContext({ sessionId }, async () => {
    const session = requireSession(sessionId);
    const state = session.state;
    const learning_mode = parseLearningMode(session.learning_mode);
    const instructionsMdRaw = typeof session.instructions_md === "string" ? String(session.instructions_md) : "";
    const instructionsMd = instructionsMdRaw.trim() ? instructionsMdRaw : null;

    if (state !== "READY") {
      const err = new Error(`Cannot generate when session state is ${state}. Expected READY.`);
      (err as any).status = 409;
      throw err;
    }

    if (typeof session.activity_id === "string" && session.activity_id.trim()) {
      const err = new Error("Session already produced an activity. Cannot re-generate.");
      (err as any).status = 409;
      throw err;
    }

    const existingTrace = parseJsonArray(session.intent_trace_json);
    const existingConfidence = parseJsonObject(session.confidence_json) as Record<string, number>;
    const commitments = parseCommitmentsJson(session.commitments_json);

    const persistTraceEvent = (entry: Record<string, unknown>) => {
      const nextTrace = appendIntentTrace(existingTrace, entry);
      threadRepository.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));
      existingTrace.splice(0, existingTrace.length, ...nextTrace);
    };

    const persistConfidencePatch = (patch: { path: string }[]) => {
      const incoming: Record<string, number> = {};
      for (const op of patch) {
        const key = op.path.startsWith("/") ? op.path.slice(1) : op.path;
        if (!key) continue;
        incoming[key] = 1;
      }
      const next = mergeConfidence(existingConfidence, incoming);
      threadRepository.updateConfidenceJson(sessionId, JSON.stringify(next));
      Object.assign(existingConfidence, next);
    };

    let progressHeartbeat: NodeJS.Timeout | null = null;

    try {
      transitionOrThrow(state, "GENERATING");
      threadRepository.updateState(sessionId, "GENERATING");
      progressHeartbeat = setInterval(() => {
        publishGenerationProgress(sessionId, { type: "heartbeat", ts: new Date().toISOString() });
      }, 1000);

      const specObj = parseSpecJson(session.spec_json);
      const specResult = ActivitySpecSchema.safeParse(specObj);
      if (!specResult.success) {
        throw new Error(`Invalid ActivitySpec: ${specResult.error.issues[0]?.message ?? "validation failed"}`);
      }
      let spec: ActivitySpec = specResult.data;
      if (!isLanguageSupportedForGeneration(spec.language)) {
        throw new Error(`Language "${spec.language}" is not supported for generation yet.`);
      }

      let resumeProblems: GeneratedProblem[] = parseGeneratedProblems(session.problems_json);
      let resumeOutcomes: GenerationOutcome[] = parseGenerationOutcomes(session.generation_outcomes_json);
      if (resumeOutcomes.length !== resumeProblems.length) {
        resumeOutcomes = resumeOutcomes.slice(0, resumeProblems.length);
      }

      let problems: GeneratedProblem[] | null = null;
      let outcomes: GenerationOutcome[] | null = null;
      let usedFallback = false;
      let appliedFallbackReason: string | null = null;

      const derivePlanForSpec = (currentSpec: ActivitySpec) => {
        const pedagogyPolicy =
          learning_mode === "guided" ? buildGuidedPedagogyPolicy({ spec: currentSpec, learnerProfile: null }) : undefined;
        return { pedagogyPolicy, plan: deriveProblemPlan(currentSpec, pedagogyPolicy) };
      };

      let { plan } = derivePlanForSpec(spec);
      threadRepository.setPlanJson(sessionId, JSON.stringify(plan));
      publishGenerationProgress(sessionId, {
        type: "generation_started",
        totalSlots: plan.length,
        totalProblems: plan.length,
        run: 1,
      });

      if (resumeProblems.length > 0) {
        for (let i = 0; i < Math.min(resumeProblems.length, plan.length); i++) {
          publishGenerationProgress(sessionId, { type: "slot_completed", slotIndex: i });
        }
      }

      while (!problems) {
        try {
          const generated = await generateProblemsFromPlan(plan, {
            customInstructionsMd: instructionsMd,
            resume: { problems: resumeProblems, outcomes: resumeOutcomes },
            onProgress: (event: GenerationProgressEvent) => publishGenerationProgress(sessionId, event),
            onCheckpoint: ({ problems: checkpointProblems, outcomes: checkpointOutcomes }) => {
              threadRepository.setProblemsJson(sessionId, JSON.stringify(checkpointProblems));
              threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(checkpointOutcomes));
            },
          });
          problems = generated.problems;
          outcomes = generated.outcomes;
        } catch (err: any) {
          if (err instanceof GenerationSlotFailureError) {
            if (Array.isArray(err.problemsSoFar)) {
              resumeProblems = err.problemsSoFar;
              threadRepository.setProblemsJson(sessionId, JSON.stringify(resumeProblems));
            }
            if (Array.isArray(err.outcomesSoFar)) {
              resumeOutcomes = err.outcomesSoFar;
              threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(resumeOutcomes));
            }

            persistTraceEvent({
              ts: new Date().toISOString(),
              type: "generation_failure",
              slotIndex: err.slotIndex,
              kind: err.kind,
              attempts: err.attempts,
              title: err.title ?? null,
              llmOutputHash: err.llmOutputHash ?? null,
              message: err.message,
              outcomes: err.outcomesSoFar ?? null,
            });

            trace("generation.failure.persisted", {
              sessionId,
              slotIndex: err.slotIndex,
              kind: err.kind,
              llmOutputHash: err.llmOutputHash,
            });

            if (!usedFallback) {
              const explicitDifficultyLocked = commitments?.difficulty_plan?.locked === true;
              const explicitTopicsLocked = commitments?.topic_tags?.locked === true;
              const decision = proposeGenerationFallbackWithPolicy(spec, {
                allowDowngradeDifficulty: !explicitDifficultyLocked,
                allowNarrowTopics: !explicitTopicsLocked,
              });
              if (decision) {
                usedFallback = true;
                appliedFallbackReason = decision.reason;

                publishGenerationProgress(sessionId, {
                  type: "generation_soft_fallback_applied",
                  reason: decision.reason,
                  patchPaths: decision.patch.map((p) => p.path),
                });

                persistTraceEvent({
                  ts: new Date().toISOString(),
                  type: "generation_soft_fallback",
                  reason: decision.reason,
                  patch: decision.patch,
                });

                persistConfidencePatch(decision.patch);

                const adjusted = applyJsonPatch(spec as any, decision.patch) as ActivitySpec;
                const adjustedRes = ActivitySpecSchema.safeParse(adjusted);
                if (!adjustedRes.success) {
                  persistTraceEvent({
                    ts: new Date().toISOString(),
                    type: "generation_soft_fallback_failed",
                    reason: "fallback patch produced invalid ActivitySpec",
                    error: adjustedRes.error.issues[0]?.message ?? "invalid",
                  });
                  throw err;
                }

                spec = adjustedRes.data;
                threadRepository.updateSpecJson(sessionId, JSON.stringify(spec));
                ({ plan } = derivePlanForSpec(spec));
                threadRepository.setPlanJson(sessionId, JSON.stringify(plan));
                continue;
              }
            }
          }

          throw err;
        }
      }

      if (!problems) {
        throw new Error("Generation failed: problems were not produced.");
      }

      if (outcomes) {
        const finalOutcomes = appliedFallbackReason
          ? outcomes.map((outcome) => ({
              ...outcome,
              appliedFallback: outcome.appliedFallback ?? appliedFallbackReason,
            }))
          : outcomes;
        threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(finalOutcomes));
        persistTraceEvent({
          ts: new Date().toISOString(),
          type: "generation_outcomes",
          outcomes: finalOutcomes,
        });
      }

      threadRepository.setProblemsJson(sessionId, JSON.stringify(problems));

      const activityId = crypto.randomUUID();
      const activityTitle = `Activity (${spec.problem_count} problems)`;

      activityRepository.create(activityId, activityTitle, JSON.stringify(problems), undefined, {
        status: "DRAFT",
        timeLimitSeconds: null,
      });

      threadRepository.setActivityId(sessionId, activityId);
      transitionOrThrow("GENERATING", "SAVED");
      threadRepository.updateState(sessionId, "SAVED");
      publishGenerationProgress(sessionId, { type: "generation_completed", activityId });
      publishGenerationProgress(sessionId, { type: "generation_complete", activityId });

      if (usedFallback) {
        persistTraceEvent({
          ts: new Date().toISOString(),
          type: "generation_soft_fallback_succeeded",
        });
      }

      return { activityId, problems };
    } catch (err: any) {
      try {
        transitionOrThrow("GENERATING", "READY");
        threadRepository.updateState(sessionId, "READY");
        threadRepository.setLastError(sessionId, err.message ?? "Unknown error during generation.");
      } catch (transitionErr) {
        console.error("Failed to transition session to READY:", transitionErr);
      }

      publishGenerationProgress(sessionId, {
        type: "generation_failed",
        error: "Generation failed. Please try again.",
        ...(err instanceof GenerationSlotFailureError ? { slotIndex: err.slotIndex } : {}),
      });
      throw err;
    } finally {
      if (progressHeartbeat) clearInterval(progressHeartbeat);
    }
  });
}

export async function regenerateSlotFromSession(
  sessionId: string,
  slotIndex: number,
  strategy:
    | "retry_full_slot"
    | "repair_reference_solution"
    | "repair_test_suite"
    | "downgrade_difficulty"
    | "narrow_topics" = "retry_full_slot"
): Promise<GenerateFromSessionResponse & { regeneratedSlotIndex: number; strategy: string }> {
  return withTraceContext({ sessionId }, async () => {
    const session = requireSession(sessionId);
    const state = session.state;

    if (state === "GENERATING") {
      const err = new Error("Cannot regenerate a slot while generation is in progress.");
      (err as any).status = 409;
      throw err;
    }

    if (typeof session.activity_id === "string" && session.activity_id.trim()) {
      const err = new Error("This session already produced an activity. Create a new thread to regenerate slots.");
      (err as any).status = 409;
      throw err;
    }

    if (state !== "READY" && state !== "FAILED") {
      const err = new Error(`Cannot regenerate slots when session state is ${state}. Expected READY or FAILED.`);
      (err as any).status = 409;
      throw err;
    }

    const specObj = parseSpecJson(session.spec_json);
    const specResult = ActivitySpecSchema.safeParse(specObj);
    if (!specResult.success) {
      throw new Error(`Invalid ActivitySpec: ${specResult.error.issues[0]?.message ?? "validation failed"}`);
    }
    const spec = specResult.data;
    if (!isLanguageSupportedForGeneration(spec.language)) {
      throw new Error(`Language "${spec.language}" is not supported for generation yet.`);
    }

    const learning_mode = parseLearningMode(session.learning_mode);
    const pedagogyPolicy =
      learning_mode === "guided" ? buildGuidedPedagogyPolicy({ spec, learnerProfile: null }) : undefined;
    const plan = deriveProblemPlan(spec, pedagogyPolicy);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= plan.length) {
      throw new Error(`slotIndex must be between 0 and ${Math.max(0, plan.length - 1)}.`);
    }

    const existingProblems = parseGeneratedProblems(session.problems_json);
    const existingOutcomes = parseGenerationOutcomes(session.generation_outcomes_json);
    const keptCount = Math.min(slotIndex, existingProblems.length, existingOutcomes.length);

    const nextProblems = existingProblems.slice(0, keptCount);
    const nextOutcomes = existingOutcomes.slice(0, keptCount);
    threadRepository.setPlanJson(sessionId, JSON.stringify(plan));
    threadRepository.setProblemsJson(sessionId, JSON.stringify(nextProblems));
    threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(nextOutcomes));
    threadRepository.setLastError(sessionId, null);

    const existingTrace = parseJsonArray(session.intent_trace_json);
    const traceEntry = {
      ts: new Date().toISOString(),
      type: "slot_regeneration_requested",
      slotIndex,
      strategy,
      keptCount,
    };
    const nextTrace = appendIntentTrace(existingTrace, traceEntry);
    threadRepository.updateIntentTraceJson(sessionId, JSON.stringify(nextTrace));

    if (state === "FAILED") {
      transitionOrThrow("FAILED", "READY");
      threadRepository.updateState(sessionId, "READY");
    }

    const out = await generateFromSession(sessionId);
    return { ...out, regeneratedSlotIndex: slotIndex, strategy };
  });
}
