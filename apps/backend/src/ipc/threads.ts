import crypto from "crypto";
import { z } from "zod";
import { runDb, runEventDb, threadDb, threadMessageDb } from "../database";
import type { LearningMode } from "../contracts/learningMode";
import {
  createSession,
  generateFromSession,
  getSession,
  processSessionMessage,
  regenerateSlotFromSession,
  setSessionInstructions,
} from "../services/sessionService";
import { getResolvedLlmSnapshot } from "../infra/llm/executionContext";
import { summarizeRoutePlan } from "../infra/llm/routePlanner";
import type { GenerationProgressEvent } from "../contracts/generationProgress";
import { getGenerationProgressBuffer, subscribeGenerationProgress } from "../generation/progressBus";
import { collectAttemptDiagnostics } from "../generation/diagnostics";
import { defaultAssistantPrompt, getNumber, getString, makeSubId, requireParams, safeJsonStringify } from "./common";
import type { RpcHandlerDef } from "./types";

type Subscription = { threadId: string; unsubscribe: () => void };
const generationSubs = new Map<string, Subscription>();

async function runGenerationWithRunTracking(args: {
  threadId: string;
  meta: Record<string, unknown>;
  execute: () => Promise<{ activityId: string; problems: unknown[] }>;
}): Promise<{ activityId: string; problemCount: number; runId: string }> {
  const runId = crypto.randomUUID();
  const routePlan = getResolvedLlmSnapshot();
  runDb.create(runId, "generation", {
    threadId: args.threadId,
    metaJson: safeJsonStringify({
      ...args.meta,
      ...(routePlan ? { routePlan: summarizeRoutePlan(routePlan) } : {}),
    }),
  });

  let seq = 0;
  const unsubPersist = subscribeGenerationProgress(args.threadId, (ev: GenerationProgressEvent) => {
    seq += 1;
    try {
      runEventDb.append(runId, seq, "progress", safeJsonStringify(ev));
    } catch {
      // ignore persistence failures; stream must still work
    }
  });

  try {
    const { activityId, problems } = await args.execute();
    runDb.finish(runId, "succeeded");
    return { activityId, problemCount: Array.isArray(problems) ? problems.length : 0, runId };
  } catch (err) {
    try {
      seq += 1;
      runEventDb.append(
        runId,
        seq,
        "error",
        safeJsonStringify({ message: err instanceof Error ? err.message : String(err) })
      );
    } catch {
      // ignore
    }
    runDb.finish(runId, "failed");
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
        const created = createSession(learning_mode ?? undefined);
        const promptText = defaultAssistantPrompt();
        threadMessageDb.create(crypto.randomUUID(), created.sessionId, "assistant", promptText);
        return {
          threadId: created.sessionId,
          state: created.state,
          learning_mode: created.learning_mode,
          nextQuestion: promptText,
          questionKey: null,
          done: false,
          next_action: "ask",
        };
      },
    },

    "threads.list": {
      schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const limit = getNumber(params.limit) ?? 20;
        const threads = threadDb.listSummaries(limit);
        return { threads };
      },
    },

    "threads.get": {
      schema: z.object({ threadId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");
        const s = getSession(threadId);
        return {
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
        };
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
        return setSessionInstructions(threadId, instructionsMd);
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
        return processSessionMessage(threadId, message);
      },
    },

    "threads.subscribeGeneration": {
      schema: z.object({ threadId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");

        getSession(threadId);

        const subId = makeSubId();
        const latest = runDb.latestByThread(threadId, "generation");
        const buffered = (() => {
          if (latest && typeof latest.id === "string" && latest.id) {
            const rows = runEventDb.listByRun(latest.id, 1500);
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
          return getGenerationProgressBuffer(threadId);
        })();
        const unsubscribe = subscribeGenerationProgress(threadId, (ev: GenerationProgressEvent) => {
          deps.sendEvent("threads.generation", { subId, event: ev });
        });
        generationSubs.set(subId, { threadId, unsubscribe });

        return { subId, buffered, ...(latest && typeof latest.id === "string" ? { runId: latest.id } : {}) };
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
      schema: z.object({ threadId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");
        return runGenerationWithRunTracking({
          threadId,
          meta: { threadId, mode: "v1", operation: "generate" },
          execute: async () => generateFromSession(threadId),
        });
      },
    },

    "threads.generateV2": {
      schema: z.object({ threadId: z.string().min(1).max(128) }).passthrough(),
      handler: async (paramsRaw) => {
        const params = requireParams(paramsRaw);
        const threadId = getString(params.threadId);
        if (!threadId) throw new Error("threadId is required.");
        return runGenerationWithRunTracking({
          threadId,
          meta: { threadId, mode: "v2", operation: "generate" },
          execute: async () => generateFromSession(threadId),
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
            const out = await regenerateSlotFromSession(threadId, slotIndex, strategy);
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

        getSession(threadId);

        const run = runId ? runDb.findById(runId) : runDb.latestByThread(threadId, "generation");
        if (!run) {
          return {
            threadId,
            runId: null,
            run: null,
            summary: {
              totalAttempts: 0,
              failedAttempts: 0,
              successfulAttempts: 0,
            },
            diagnostics: [],
            latestFailure: null,
            errors: [],
          };
        }

        if (run.kind !== "generation") {
          throw new Error("runId does not reference a generation run.");
        }
        if (String(run.thread_id ?? "") !== threadId) {
          throw new Error("runId does not belong to the provided threadId.");
        }

        const rows = runEventDb.listByRun(run.id, limit);
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

        return {
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
