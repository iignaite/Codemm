import crypto from "crypto";
import { z } from "zod";
import { runEventRepository, runRepository } from "../database/repositories/runRepository";
import { threadMessageRepository, threadRepository } from "../database/repositories/threadRepository";
import type { LearningMode } from "../contracts/learningMode";
import {
  createThread,
  generateFromThread,
  getThread,
  processThreadMessage,
  regenerateSlotFromThread,
  setThreadInstructions,
} from "../services/sessionService";
import { getResolvedLlmSnapshot } from "../infra/llm/executionContext";
import { summarizeRoutePlan } from "../infra/llm/runtimeService";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import type {
  CreateThreadResponseDto,
  GenerateThreadResponseDto,
  GenerationDiagnosticsDto,
  ThreadDetailDto,
  ThreadListResponseDto,
  UpdateThreadInstructionsResponseDto,
} from "@codemm/shared-contracts";
import { getGenerationProgressBuffer, subscribeGenerationProgress } from "../generation/progressBus";
import { collectAttemptDiagnostics } from "../generation/diagnostics";
import { defaultAssistantPrompt, getNumber, getString, makeSubId, requireParams, safeJsonStringify } from "./common";
import type { RpcHandlerDef } from "./types";

type Subscription = { threadId: string; runId: string; unsubscribe: () => void };
const generationSubs = new Map<string, Subscription>();

async function runGenerationWithRunTracking(args: {
  threadId: string;
  runId?: string;
  meta: Record<string, unknown>;
  execute: (runId: string) => Promise<{ activityId: string; problems: unknown[] }>;
}): Promise<GenerateThreadResponseDto> {
  const runId = typeof args.runId === "string" && args.runId.trim() ? args.runId : crypto.randomUUID();
  const routePlan = getResolvedLlmSnapshot();
  runRepository.create(runId, "generation", {
    threadId: args.threadId,
    metaJson: safeJsonStringify({
      ...args.meta,
      ...(routePlan ? { routePlan: summarizeRoutePlan(routePlan) } : {}),
    }),
  });

  let seq = 0;
  const unsubPersist = subscribeGenerationProgress(runId, (ev: GenerationProgressEvent) => {
    seq += 1;
    try {
      runEventRepository.append(runId, seq, "progress", safeJsonStringify(ev));
    } catch {
      // ignore persistence failures; stream must still work
    }
  });

  try {
    const { activityId, problems } = await args.execute(runId);
    runRepository.finish(runId, "succeeded");
    return { activityId, problemCount: Array.isArray(problems) ? problems.length : 0, runId };
  } catch (err) {
    try {
      seq += 1;
      runEventRepository.append(
        runId,
        seq,
        "error",
        safeJsonStringify({ message: err instanceof Error ? err.message : String(err) })
      );
    } catch {
      // ignore
    }
    runRepository.finish(runId, "failed");
    throw err;
  } finally {
    try {
      unsubPersist();
    } catch {
      // ignore
    }
  }
}

export function createThreadHandlers(deps: {
  sendEvent: (topic: string, payload: unknown) => void;
}): Record<string, RpcHandlerDef> {
  return {
    "threads.create": {
      schema: z.object({ learning_mode: z.any().optional() }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const learning_mode = (params.learning_mode ?? null) as LearningMode | null;
        const created = createThread(learning_mode ?? undefined);
        const promptText = defaultAssistantPrompt();
        threadMessageRepository.create(crypto.randomUUID(), created.sessionId, "assistant", promptText);
        const response: CreateThreadResponseDto = {
          threadId: created.sessionId,
          state: created.state,
          learning_mode: created.learning_mode,
          nextQuestion: promptText,
          questionKey: null,
          done: false,
          next_action: "ask",
        };
        return response;
      },
    },

    "threads.list": {
      schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const limit = getNumber(params.limit) ?? 20;
        const threads = threadRepository.listSummaries(limit);
        const response: ThreadListResponseDto = { threads };
        return response;
      },
    },

    "threads.get": {
      schema: z.object({ threadId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");
        const s = getThread(threadId);
        const response: ThreadDetailDto = {
          threadId: s.id,
          state: s.state,
          learning_mode: s.learning_mode,
          instructions_md: s.instructions_md,
          spec: s.spec,
          messages: s.messages,
          collector: s.collector,
          confidence: s.confidence,
          commitments: s.commitments,
          generationOutcomes: s.generationOutcomes,
          intentTrace: s.intentTrace,
          latestGenerationRunId: s.latestGenerationRunId ?? null,
          latestGenerationRunStatus: s.latestGenerationRunStatus ?? null,
        };
        return response;
      },
    },

    "threads.setInstructions": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          instructions_md: z.string().max(8000).nullable(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");
        const raw = params.instructions_md;
        const instructionsMd = typeof raw === "string" ? raw : raw === null ? null : null;
        if (typeof instructionsMd === "string" && instructionsMd.length > 8000) {
          throw new Error("instructions_md is too large.");
        }
        const response: UpdateThreadInstructionsResponseDto = setThreadInstructions(threadId, instructionsMd);
        return response;
      },
    },

    "threads.postMessage": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          message: z.string().min(1).max(50_000),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const message = getString(params.message);
        if (!threadId) throw new Error("threadId is required.");
        if (!message) throw new Error("message is required.");
        return processThreadMessage(threadId, message);
      },
    },

    "threads.subscribeGeneration": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          runId: z.string().min(1).max(128).optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const requestedRunId = getString(params.runId);
        if (!threadId) throw new Error("threadId is required.");

        getThread(threadId);
        if (requestedRunId) {
          const run = runRepository.findById(requestedRunId);
          if (!run) {
            throw new Error("runId does not reference a generation run.");
          }
          if (run.kind !== "generation") {
            throw new Error("runId does not reference a generation run.");
          }
          if (String(run.thread_id ?? "") !== threadId) {
            throw new Error("runId does not belong to the provided threadId.");
          }
        }

        const subId = makeSubId();
        const latest = runRepository.latestByThread(threadId, "generation");
        const effectiveRunId = requestedRunId ?? (latest && typeof latest.id === "string" ? latest.id : null);
        const buffered = (() => {
          if (effectiveRunId) {
            const rows = runEventRepository.listByRun(effectiveRunId, 1500);
            const events: GenerationProgressEvent[] = [];
            for (const r of rows) {
              if (r.type !== "progress") continue;
              try {
                const parsed = JSON.parse(r.payload_json) as GenerationProgressEvent;
                if (parsed && typeof parsed.type === "string") events.push(parsed);
              } catch {
                // ignore
              }
            }
            if (events.length > 0) return events;
          }
          return effectiveRunId ? getGenerationProgressBuffer(effectiveRunId) : [];
        })();
        const subscribeRunId = effectiveRunId ?? requestedRunId;
        if (!subscribeRunId) {
          throw new Error("runId is required to subscribe before a generation run has been persisted.");
        }
        const unsubscribe = subscribeGenerationProgress(subscribeRunId, (ev: GenerationProgressEvent) => {
          deps.sendEvent("threads.generation", { subId, event: ev });
        });
        generationSubs.set(subId, { threadId, runId: subscribeRunId, unsubscribe });

        return { subId, buffered, runId: subscribeRunId };
      },
    },

    "threads.unsubscribeGeneration": {
      schema: z.object({ subId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const subId = getString(params.subId);
        if (!subId) throw new Error("subId is required.");
        const sub = generationSubs.get(subId);
        if (sub) {
          try {
            sub.unsubscribe();
          } finally {
            generationSubs.delete(subId);
          }
        }
        return { ok: true };
      },
    },

    "threads.generate": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          runId: z.string().min(1).max(128).optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const runId = getString(params.runId);
        if (!threadId) throw new Error("threadId is required.");
        return runGenerationWithRunTracking({
          threadId,
          ...(runId ? { runId } : {}),
          meta: { threadId, mode: "v1", operation: "generate" },
          execute: async (effectiveRunId) => generateFromThread(threadId, { runId: effectiveRunId }),
        });
      },
    },

    "threads.generateV2": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          runId: z.string().min(1).max(128).optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const runId = getString(params.runId);
        if (!threadId) throw new Error("threadId is required.");
        return runGenerationWithRunTracking({
          threadId,
          ...(runId ? { runId } : {}),
          meta: { threadId, mode: "v2", operation: "generate" },
          execute: async (effectiveRunId) => generateFromThread(threadId, { runId: effectiveRunId }),
        });
      },
    },

    "threads.regenerateSlot": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          slotIndex: z.number().int().min(0).max(256),
          strategy: z
            .enum([
              "retry_full_slot",
              "repair_reference_solution",
              "repair_test_suite",
              "downgrade_difficulty",
              "narrow_topics",
            ])
            .optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const slotIndex = typeof params.slotIndex === "number" ? params.slotIndex : null;
        const strategy =
          params.strategy === "retry_full_slot" ||
          params.strategy === "repair_reference_solution" ||
          params.strategy === "repair_test_suite" ||
          params.strategy === "downgrade_difficulty" ||
          params.strategy === "narrow_topics"
            ? params.strategy
            : "retry_full_slot";
        if (!threadId) throw new Error("threadId is required.");
        if (slotIndex === null) throw new Error("slotIndex is required.");

        return runGenerationWithRunTracking({
          threadId,
          meta: { threadId, mode: "v2", operation: "regenerate_slot", slotIndex, strategy },
          execute: async () => {
            const out = await regenerateSlotFromThread(threadId, slotIndex, strategy);
            return { activityId: out.activityId, problems: out.problems };
          },
        });
      },
    },

    "threads.getGenerationDiagnostics": {
      schema: z
        .object({
          threadId: z.string().min(1).max(128),
          runId: z.string().min(1).max(128).optional(),
          limit: z.number().int().min(1).max(5000).optional(),
        })
        .passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        const runId = getString(params.runId);
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 5000;
        if (!threadId) throw new Error("threadId is required.");

        getThread(threadId);

        const run = runId ? runRepository.findById(runId) : runRepository.latestByThread(threadId, "generation");
        if (!run) {
          const response: GenerationDiagnosticsDto = {
            threadId,
            runId: null,
            run: null,
            summary: {
              totalAttempts: 0,
              failedAttempts: 0,
              successfulAttempts: 0,
            },
            diagnostics: [],
            routeSelections: [],
            stageTimeline: [],
            latestFailure: null,
            errors: [],
          };
          return response;
        }

        if (run.kind !== "generation") {
          throw new Error("runId does not reference a generation run.");
        }
        if (String(run.thread_id ?? "") !== threadId) {
          throw new Error("runId does not belong to the provided threadId.");
        }

        const rows = runEventRepository.listByRun(run.id, limit);
        const { diagnostics, latestFailure, routeSelections, stageTimeline, timingSummary } = collectAttemptDiagnostics(rows);
        const failedAttempts = diagnostics.filter((d) => d.status === "failed").length;
        const successfulAttempts = diagnostics.filter((d) => d.status === "success").length;
        const errors = rows
          .filter((r) => r.type === "error")
          .map((r) => {
            try {
              const payload = JSON.parse(r.payload_json);
              return {
                seq: r.seq,
                ...(typeof payload?.message === "string" ? { message: payload.message } : { message: "Unknown error" }),
                createdAt: r.created_at,
              };
            } catch {
              return { seq: r.seq, message: "Unknown error", createdAt: r.created_at };
            }
          });

        const response: GenerationDiagnosticsDto = {
          threadId,
          runId: run.id,
          run: {
            id: run.id,
            status: run.status,
            createdAt: run.created_at,
            finishedAt: run.finished_at ?? null,
            meta: (() => {
              try {
                return run.meta_json ? JSON.parse(run.meta_json) : null;
              } catch {
                return null;
              }
            })(),
          },
          summary: {
            totalAttempts: diagnostics.length,
            failedAttempts,
            successfulAttempts,
            llmMs: timingSummary.llmMs,
            dockerMs: timingSummary.dockerMs,
            totalStageMs: timingSummary.totalStageMs,
            ...(latestFailure ? { finalFailureKind: latestFailure.kind } : {}),
          },
          diagnostics,
          routeSelections,
          stageTimeline,
          latestFailure,
          errors,
        };
        return response;
      },
    },
  };
}

export function shutdownThreadHandlers() {
  for (const [subId, sub] of generationSubs.entries()) {
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
    generationSubs.delete(subId);
  }
}
