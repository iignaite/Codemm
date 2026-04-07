import crypto from "crypto";
import { ActivitySpecSchema, type ActivitySpec } from "../../contracts/activitySpec";
import { createExecutionContext } from "../../engine/execution/ExecutionContext";
import { ExecutionEngine } from "../../engine/execution/ExecutionEngine";
import type { Step } from "../../engine/execution/Step";
import { isLanguageSupportedForGeneration } from "../../languages/profiles";
import { deriveProblemPlan } from "../../planner";
import { buildGuidedPedagogyPolicy } from "../../planner/pedagogy";
import { generateProblemsFromPlan } from "../../generation";
import type { GeneratedProblem } from "../../contracts/problem";
import type { GenerationOutcome } from "../../contracts/generationOutcome";
import type { GenerationProgressEvent } from "../../contracts/generationProgress";
import { publishGenerationProgress } from "../../generation/progressBus";
import { applyJsonPatch } from "../../compiler/jsonPatch";
import { proposeGenerationFallbackWithPolicy } from "../../agent/generationFallback";
import { trace } from "../../utils/trace";
import { withTraceContext } from "../../utils/traceContext";
import { activityRepository } from "../../database/repositories/activityRepository";
import { threadRepository } from "../../database/repositories/threadRepository";
import {
  generationRunRepository,
  generationSlotRunRepository,
} from "../../database/repositories/generationRunRepository";
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
import { deriveRunStatus, mapRunStatusToThreadState, type SlotExecutionResult } from "./generationState";
import type { GenerationFailureKind, GenerationRunStatus, GenerationSlotStage } from "@codemm/shared-contracts";
import type { SessionState } from "../../contracts/session";

export type GenerateFromSessionResponse = {
  activityId: string;
  problems: GeneratedProblem[];
};

export type GenerateFromThreadResponse = GenerateFromSessionResponse;

function currentIso() {
  return new Date().toISOString();
}

function translateEventStage(stage: "skeleton" | "tests" | "reference" | "validate" | "repair"): GenerationSlotStage {
  if (stage === "skeleton") return "SKELETON_RUNNING";
  if (stage === "tests") return "TESTS_RUNNING";
  if (stage === "reference") return "REFERENCE_RUNNING";
  if (stage === "repair") return "REPAIRING_REFERENCE";
  return "VALIDATING_REFERENCE";
}

function isTerminalRunStatus(status: GenerationRunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "PARTIAL_SUCCESS" ||
    status === "RETRYABLE_FAILURE" ||
    status === "HARD_FAILURE" ||
    status === "ABORTED"
  );
}

function getLastFailure(results: SlotExecutionResult[]): {
  kind?: GenerationFailureKind | null;
  code?: string | null;
  message?: string | null;
} {
  const lastFailure = [...results].reverse().find((result) => result.terminalStatus !== "SUCCEEDED");
  if (!lastFailure || !("failure" in lastFailure)) return {};
  return {
    kind: lastFailure.failure.kind,
    code: lastFailure.failure.code,
    message: lastFailure.failure.message,
  };
}

export async function generateFromThread(
  sessionId: string,
  opts?: { runId?: string }
): Promise<GenerateFromThreadResponse> {
  const runId = typeof opts?.runId === "string" && opts.runId.trim() ? opts.runId : crypto.randomUUID();
  return withTraceContext({ sessionId, threadId: sessionId, runId }, async () => {
    const session = requireSession(sessionId);
    const state = session.state as SessionState;
    const learning_mode = parseLearningMode(session.learning_mode);
    const instructionsMdRaw = typeof session.instructions_md === "string" ? String(session.instructions_md) : "";
    const instructionsMd = instructionsMdRaw.trim() ? instructionsMdRaw : null;
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
    let spec: ActivitySpec | null = null;
    let plan: ReturnType<typeof deriveProblemPlan> = [];
    let problems: GeneratedProblem[] | null = null;
    let outcomes: GenerationOutcome[] | null = null;
    let slotResults: SlotExecutionResult[] = [];
    let usedFallback = false;
    let appliedFallbackReason: string | null = null;
    let runStatus: GenerationRunStatus = "PENDING";
    let currentThreadState: SessionState = state;

    const derivePlanForSpec = (currentSpec: ActivitySpec) => {
      const pedagogyPolicy =
        learning_mode === "guided" ? buildGuidedPedagogyPolicy({ spec: currentSpec, learnerProfile: null }) : undefined;
      return { pedagogyPolicy, plan: deriveProblemPlan(currentSpec, pedagogyPolicy) };
    };

    const persistRunProgress = (event: GenerationProgressEvent) => {
      const runScopedEvent = event.runId ? event : ({ ...event, runId } as GenerationProgressEvent);
      if (runScopedEvent.type === "slot_started") {
        generationSlotRunRepository.beginSlot({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          topic: runScopedEvent.topic,
          language: runScopedEvent.language,
        });
        generationSlotRunRepository.appendTransition({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: "slot_started",
          payload: runScopedEvent,
        });
      } else if (runScopedEvent.type === "slot_stage_started") {
        generationSlotRunRepository.updateStage({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: translateEventStage(runScopedEvent.stage),
          currentStage: translateEventStage(runScopedEvent.stage),
          attemptCount: runScopedEvent.attempt,
        });
        generationSlotRunRepository.appendTransition({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          attempt: runScopedEvent.attempt,
          stage: runScopedEvent.stage,
          status: "stage_started",
          payload: runScopedEvent,
        });
      } else if (runScopedEvent.type === "slot_stage_finished") {
        generationSlotRunRepository.updateStage({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: translateEventStage(runScopedEvent.stage),
          currentStage: translateEventStage(runScopedEvent.stage),
          attemptCount: runScopedEvent.attempt,
          lastFailureKind: runScopedEvent.status === "failed" ? runScopedEvent.failureKind ?? null : null,
          lastFailureCode:
            runScopedEvent.status === "failed"
              ? runScopedEvent.timedOut
                ? "EXEC_TIMEOUT"
                : runScopedEvent.failureKind === "compile"
                  ? "COMPILE_ERROR"
                  : runScopedEvent.failureKind === "tests"
                    ? "TEST_FAILURE"
                    : runScopedEvent.failureKind === "infra"
                      ? "INFRA_ERROR"
                      : null
              : null,
          lastFailureMessage: runScopedEvent.status === "failed" ? runScopedEvent.message ?? null : null,
          lastArtifactHash: runScopedEvent.artifactHash ?? null,
        });
        generationSlotRunRepository.appendTransition({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          attempt: runScopedEvent.attempt,
          stage: runScopedEvent.stage,
          status: runScopedEvent.status === "success" ? "stage_succeeded" : "stage_failed",
          payload: runScopedEvent,
        });
      } else if (runScopedEvent.type === "slot_completed") {
        const slot = generationSlotRunRepository.find(runId, runScopedEvent.slotIndex);
        generationSlotRunRepository.markTerminal({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: "SUCCEEDED",
          attemptCount: slot?.attempt_count ?? 1,
        });
        generationSlotRunRepository.appendTransition({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: "slot_succeeded",
          payload: runScopedEvent,
        });
      } else if (runScopedEvent.type === "slot_failed_terminal") {
        const slot = generationSlotRunRepository.find(runId, runScopedEvent.slotIndex);
        generationSlotRunRepository.markTerminal({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          status: runScopedEvent.failureKind === "infra" ? "HARD_FAILURE" : "RETRYABLE_FAILURE",
          attemptCount: slot?.attempt_count ?? 1,
          lastFailureKind: runScopedEvent.failureKind,
          lastFailureCode:
            runScopedEvent.failureKind === "timeout" ? "EXEC_TIMEOUT" : `STAGE_${runScopedEvent.stage.toUpperCase()}`,
          lastFailureMessage: runScopedEvent.message,
        });
        generationSlotRunRepository.appendTransition({
          runId,
          slotIndex: runScopedEvent.slotIndex,
          stage: runScopedEvent.stage,
          status: "slot_failed_terminal",
          payload: runScopedEvent,
        });
      }
      publishGenerationProgress(runId, runScopedEvent);
    };

    const workflow = createExecutionContext<Record<string, unknown>, { response?: GenerateFromThreadResponse }>({
      workflowId: `thread-generation:${sessionId}:${runId}`,
      threadId: sessionId,
      runId,
      publishProgress: (event) => persistRunProgress(event as GenerationProgressEvent),
      loggerName: "threads.generation",
      initialState: {},
      initialResults: {},
    });
    const steps: Step<Record<string, unknown>, { response?: GenerateFromThreadResponse }>[] = [
      {
        id: "prepare-thread-generation",
        run: async () => {
          if (!["READY", "RETRYABLE_FAILURE", "HARD_FAILURE"].includes(state)) {
            const err = new Error(
              `Cannot generate when session state is ${state}. Expected READY, RETRYABLE_FAILURE, or HARD_FAILURE.`
            );
            (err as any).status = 409;
            throw err;
          }
          if (typeof session.activity_id === "string" && session.activity_id.trim()) {
            const err = new Error("Session already produced an activity. Cannot re-generate.");
            (err as any).status = 409;
            throw err;
          }

          transitionOrThrow(state as any, "GENERATE_PENDING");
          threadRepository.updateState(sessionId, "GENERATE_PENDING");
          currentThreadState = "GENERATE_PENDING";
          threadRepository.setLastError(sessionId, null);
          progressHeartbeat = setInterval(() => {
            persistRunProgress({ type: "heartbeat", ts: currentIso() });
          }, 1000);

          const specObj = parseSpecJson(session.spec_json);
          const specResult = ActivitySpecSchema.safeParse(specObj);
          if (!specResult.success) {
            throw new Error(`Invalid ActivitySpec: ${specResult.error.issues[0]?.message ?? "validation failed"}`);
          }
          spec = specResult.data;
          if (!isLanguageSupportedForGeneration(spec.language)) {
            throw new Error(`Language "${spec.language}" is not supported for generation yet.`);
          }

          ({ plan } = derivePlanForSpec(spec));
          generationRunRepository.create({
            id: runId,
            threadId: sessionId,
            totalSlots: plan.length,
            metaJson: JSON.stringify({ threadId: sessionId, usedFallback: false }),
          });
          generationSlotRunRepository.seed(
            runId,
            plan.map((slot) => ({
              slotIndex: slot.index,
              topic: slot.topics[0] ?? null,
              language: slot.language,
            }))
          );
          generationRunRepository.markRunning(runId);
          transitionOrThrow("GENERATE_PENDING", "GENERATING");
          threadRepository.updateState(sessionId, "GENERATING");
          currentThreadState = "GENERATING";
          threadRepository.setPlanJson(sessionId, JSON.stringify(plan));
          persistRunProgress({
            type: "generation_started",
            totalSlots: plan.length,
            totalProblems: plan.length,
            run: 1,
          });
          persistRunProgress({ type: "generation_run_status", status: "RUNNING" });
        },
      },
      {
        id: "run-generation-pipeline",
        run: async () => {
          while (!problems) {
            const generated = await generateProblemsFromPlan(plan, {
              customInstructionsMd: instructionsMd,
              onProgress: (event: GenerationProgressEvent) => persistRunProgress(event),
              onCheckpoint: ({ problems: checkpointProblems, outcomes: checkpointOutcomes }) => {
                threadRepository.setProblemsJson(sessionId, JSON.stringify(checkpointProblems));
                threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(checkpointOutcomes));
              },
            });
            problems = generated.problems;
            outcomes = generated.outcomes;
            slotResults = generated.slotResults;

            const allFailed = slotResults.length > 0 && slotResults.every((result) => result.terminalStatus !== "SUCCEEDED");
            if (allFailed && !usedFallback && spec) {
              const explicitDifficultyLocked = commitments?.difficulty_plan?.locked === true;
              const explicitTopicsLocked = commitments?.topic_tags?.locked === true;
              const decision = proposeGenerationFallbackWithPolicy(spec, {
                allowDowngradeDifficulty: !explicitDifficultyLocked,
                allowNarrowTopics: !explicitTopicsLocked,
              });
              if (decision) {
                usedFallback = true;
                appliedFallbackReason = decision.reason;

                persistRunProgress({
                  type: "generation_soft_fallback_applied",
                  reason: decision.reason,
                  patchPaths: decision.patch.map((p) => p.path),
                });

                persistTraceEvent({
                  ts: currentIso(),
                  type: "generation_soft_fallback",
                  reason: decision.reason,
                  patch: decision.patch,
                });

                persistConfidencePatch(decision.patch);

                const adjusted = applyJsonPatch(spec as any, decision.patch) as ActivitySpec;
                const adjustedRes = ActivitySpecSchema.safeParse(adjusted);
                if (!adjustedRes.success) {
                  persistTraceEvent({
                    ts: currentIso(),
                    type: "generation_soft_fallback_failed",
                    reason: "fallback patch produced invalid ActivitySpec",
                    error: adjustedRes.error.issues[0]?.message ?? "invalid",
                  });
                  throw new Error("Fallback patch produced an invalid ActivitySpec.");
                }

                spec = adjustedRes.data;
                threadRepository.updateSpecJson(sessionId, JSON.stringify(spec));
                ({ plan } = derivePlanForSpec(spec));
                threadRepository.setPlanJson(sessionId, JSON.stringify(plan));
                generationSlotRunRepository.seed(
                  runId,
                  plan.map((slot) => ({
                    slotIndex: slot.index,
                    topic: slot.topics[0] ?? null,
                    language: slot.language,
                  }))
                );
                problems = null;
                outcomes = null;
                slotResults = [];
                continue;
              }
            }
            break;
          }
        },
      },
      {
        id: "persist-generated-activity",
        run: async (ctx) => {
          if (!problems || !outcomes || !spec) {
            throw new Error("Generation did not produce finalized results.");
          }

          const finalOutcomes = appliedFallbackReason
            ? outcomes.map((outcome) => ({
                ...outcome,
                appliedFallback: outcome.appliedFallback ?? appliedFallbackReason,
              }))
            : outcomes;
          threadRepository.updateGenerationOutcomesJson(sessionId, JSON.stringify(finalOutcomes));
          persistTraceEvent({
            ts: currentIso(),
            type: "generation_outcomes",
            outcomes: finalOutcomes,
            runId,
          });

          threadRepository.setProblemsJson(sessionId, JSON.stringify(problems));
          runStatus = deriveRunStatus(slotResults);
          const successfulSlots = slotResults.filter((result) => result.terminalStatus === "SUCCEEDED").length;
          const failedSlots = slotResults.filter((result) => result.terminalStatus !== "SUCCEEDED").length;
          const { kind: lastFailureKind, code: lastFailureCode, message: lastFailureMessage } = getLastFailure(slotResults);

          let activityId: string | null = null;
          if (problems.length > 0) {
            activityId = crypto.randomUUID();
            const activityTitle = `Activity (${problems.length} of ${spec.problem_count} problems)`;
            activityRepository.create(activityId, activityTitle, JSON.stringify(problems), undefined, {
              status: "DRAFT",
              timeLimitSeconds: null,
            });
            threadRepository.setActivityId(sessionId, activityId);
          }

          generationRunRepository.finish({
            id: runId,
            status: runStatus,
            activityId,
            completedSlots: slotResults.length,
            successfulSlots,
            failedSlots,
            lastFailureKind: lastFailureKind ?? null,
            lastFailureCode: lastFailureCode ?? null,
            lastFailureMessage: lastFailureMessage ?? null,
          });

          const terminalThreadState = mapRunStatusToThreadState(runStatus);
          transitionOrThrow("GENERATING", terminalThreadState as any);
          threadRepository.updateState(sessionId, terminalThreadState);
          currentThreadState = terminalThreadState;
          threadRepository.setLastError(
            sessionId,
            runStatus === "COMPLETED" ? null : lastFailureMessage ?? (runStatus === "PARTIAL_SUCCESS" ? "Generation completed with slot failures." : "Generation failed.")
          );
          persistRunProgress({
            type: "generation_run_status",
            status: runStatus,
            ...(activityId ? { activityId } : {}),
            ...(lastFailureMessage ? { error: lastFailureMessage } : {}),
          });
          if (activityId) {
            persistRunProgress({ type: "generation_completed", activityId });
            persistRunProgress({ type: "generation_complete", activityId });
          } else {
            persistRunProgress({
              type: "generation_failed",
              error: lastFailureMessage ?? "Generation failed.",
            });
          }

          if (usedFallback) {
            persistTraceEvent({
              ts: currentIso(),
              type: "generation_soft_fallback_succeeded",
              runId,
            });
          }

          if (!activityId) {
            throw new Error(lastFailureMessage ?? "Generation failed without producing any problems.");
          }
          ctx.setResult("response", { activityId, problems });
        },
      },
    ];

    try {
      await new ExecutionEngine(steps).run(workflow);
      const response = workflow.getResult("response");
      if (!response) throw new Error("Generation completed without a response payload.");
      return response;
    } catch (err: any) {
      const failureRunStatus: GenerationRunStatus =
        isTerminalRunStatus(runStatus)
          ? runStatus
          : String(err?.message ?? "").toLowerCase().includes("invalid activityspec")
            ? "HARD_FAILURE"
            : "RETRYABLE_FAILURE";
      try {
        const failureState = mapRunStatusToThreadState(failureRunStatus);
        if (currentThreadState !== failureState) {
          transitionOrThrow(currentThreadState as any, failureState as any);
          threadRepository.updateState(sessionId, failureState);
          currentThreadState = failureState;
        }
        threadRepository.setLastError(sessionId, err.message ?? "Unknown error during generation.");
        const persistedRun = generationRunRepository.findById(runId);
        if (!persistedRun || !isTerminalRunStatus(persistedRun.status as GenerationRunStatus)) {
          generationRunRepository.finish({
            id: runId,
            status: failureRunStatus,
            completedSlots: slotResults.length,
            successfulSlots: slotResults.filter((result) => result.terminalStatus === "SUCCEEDED").length,
            failedSlots: slotResults.filter((result) => result.terminalStatus !== "SUCCEEDED").length,
            lastFailureKind: "infra",
            lastFailureCode: "THREAD_GENERATION_FAILED",
            lastFailureMessage: err.message ?? "Unknown error during generation.",
          });
          persistRunProgress({
            type: "generation_run_status",
            status: failureRunStatus,
            error: err.message ?? "Unknown error during generation.",
          });
          persistRunProgress({
            type: "generation_failed",
            error: "Generation failed. Please try again.",
          });
        }
      } catch (transitionErr) {
        console.error("Failed to transition session after generation error:", transitionErr);
      }
      throw err;
    } finally {
      if (progressHeartbeat) clearInterval(progressHeartbeat);
    }
  });
}

export const generateFromSession = generateFromThread;

export async function regenerateSlotFromThread(
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
    if (strategy !== "retry_full_slot") {
      const err = new Error(
        `Slot regeneration strategy "${strategy}" is deprecated until stage-targeted slot resume is implemented. Use "retry_full_slot".`
      );
      (err as any).status = 400;
      throw err;
    }

    const session = requireSession(sessionId);
    const state = session.state;

    if (state === "GENERATING" || state === "GENERATE_PENDING") {
      const err = new Error("Cannot regenerate a slot while generation is in progress.");
      (err as any).status = 409;
      throw err;
    }

    if (typeof session.activity_id === "string" && session.activity_id.trim()) {
      const err = new Error("This session already produced an activity. Create a new thread to regenerate slots.");
      (err as any).status = 409;
      throw err;
    }

    if (!["READY", "RETRYABLE_FAILURE", "HARD_FAILURE"].includes(state)) {
      const err = new Error(
        `Cannot regenerate slots when session state is ${state}. Expected READY, RETRYABLE_FAILURE, or HARD_FAILURE.`
      );
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

    if (state === "RETRYABLE_FAILURE" || state === "HARD_FAILURE") {
      transitionOrThrow(state as any, "READY");
      threadRepository.updateState(sessionId, "READY");
    }

    const out = await generateFromThread(sessionId);
    return { ...out, regeneratedSlotIndex: slotIndex, strategy };
  });
}

export const regenerateSlotFromSession = regenerateSlotFromThread;
