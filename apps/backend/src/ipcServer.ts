import crypto from "crypto";
import { initializeDatabase, activityDb, runDb, runEventDb, submissionDb, threadDb, threadMessageDb } from "./database";
import type { LearningMode } from "./contracts/learningMode";
import {
  createSession,
  generateFromSession,
  getSession,
  processSessionMessage,
  regenerateSlotFromSession,
  setSessionInstructions,
} from "./services/sessionService";
import { getResolvedLlmSnapshot, withResolvedLlmSnapshot } from "./infra/llm/executionContext";
import { summarizeRoutePlan } from "./infra/llm/routePlanner";
import type { ResolvedLlmRoutePlan, ResolvedLlmSnapshot } from "./infra/llm/types";
import { ActivityLanguageSchema } from "./contracts/activitySpec";
import {
  getLanguageProfile,
  isLanguageSupportedForExecution,
  isLanguageSupportedForJudge,
} from "./languages/profiles";
import type { GenerationProgressEvent } from "./contracts/generationProgress";
import { getGenerationProgressBuffer, subscribeGenerationProgress } from "./generation/progressBus";
import { collectAttemptDiagnostics } from "./generation/diagnostics";
import { editDraftProblemWithAi } from "./services/activityProblemEditService";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

type RpcRequest = {
  id: string;
  type: "req";
  method: string;
  params?: JsonObject;
  context?: {
    llmSnapshot?: ResolvedLlmSnapshot | null;
    llmRoutePlan?: ResolvedLlmRoutePlan | null;
  };
};

type RpcResponse =
  | { id: string; type: "res"; ok: true; result: unknown }
  | { id: string; type: "res"; ok: false; error: { message: string; stack?: string } };

type RpcEvent = {
  type: "event";
  topic: string;
  payload: unknown;
};

function isObject(x: unknown): x is JsonObject {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function getString(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

function getNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function send(msg: RpcResponse | RpcEvent) {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

function replyOk(id: string, result: unknown) {
  send({ id, type: "res", ok: true, result });
}

function replyErr(id: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  send({
    id,
    type: "res",
    ok: false,
    error: {
      message: e.message,
      ...(typeof e.stack === "string" ? { stack: e.stack } : {}),
    },
  });
}

function requireParams(params: unknown): JsonObject {
  if (!isObject(params)) throw new Error("Invalid params.");
  return params;
}

function defaultAssistantPrompt(): string {
  return "How can I help you today?\n\nTell me what you want to learn, and optionally the language (java/python/cpp/sql) and how many problems (1–7).";
}

type Subscription = { threadId: string; unsubscribe: () => void };
const generationSubs = new Map<string, Subscription>();

function makeSubId(): string {
  return crypto.randomUUID();
}

function safeJsonStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

type RpcHandler = (paramsRaw: unknown) => Promise<unknown>;
type RpcHandlerDef = {
  schema?: z.ZodTypeAny;
  handler: RpcHandler;
};

function validateOrThrow(schema: z.ZodTypeAny, paramsRaw: unknown): unknown {
  const res = schema.safeParse(paramsRaw);
  if (!res.success) {
    const msg = res.error.issues?.[0]?.message || "Invalid params.";
    throw new ValidationError(msg);
  }
  return res.data;
}

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

const rpcHandlers: Record<string, RpcHandlerDef> = {
  "engine.ping": {
    handler: async () => ({ ok: true }),
  },

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

      // Ensure thread exists.
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
              if (parsed && typeof (parsed as any).type === "string") events.push(parsed);
            } catch {
              // ignore
            }
          }
          if (events.length > 0) return events;
        }
        return getGenerationProgressBuffer(threadId);
      })();
      const unsubscribe = subscribeGenerationProgress(threadId, (ev: GenerationProgressEvent) => {
        send({ type: "event", topic: "threads.generation", payload: { subId, event: ev } });
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

      // Ensure thread exists before listing diagnostics.
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

  "activities.get": {
    schema: z.object({ id: z.string().min(1).max(128) }).passthrough(),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const id = getString(params.id);
      if (!id) throw new Error("id is required.");
      const dbActivity = activityDb.findById(id);
      if (!dbActivity) throw new Error("Activity not found.");
      return {
        activity: {
          id: dbActivity.id,
          title: dbActivity.title,
          prompt: dbActivity.prompt || "",
          problems: JSON.parse(dbActivity.problems),
          status: (dbActivity.status as any) ?? "DRAFT",
          timeLimitSeconds: typeof dbActivity.time_limit_seconds === "number" ? dbActivity.time_limit_seconds : null,
          createdAt: dbActivity.created_at,
        },
      };
    },
  },

  "activities.list": {
    schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).passthrough(),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const limit = getNumber(params.limit) ?? 30;
      const activities = activityDb.listSummaries(limit);
      return { activities };
    },
  },

  "activities.patch": {
    schema: z
      .object({
        id: z.string().min(1).max(128),
        title: z.string().max(200).optional(),
        timeLimitSeconds: z.number().int().min(0).max(8 * 60 * 60).nullable().optional(),
      })
      .passthrough(),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const id = getString(params.id);
      if (!id) throw new Error("id is required.");
      const dbActivity = activityDb.findById(id);
      if (!dbActivity) throw new Error("Activity not found.");
      if ((dbActivity.status ?? "DRAFT") !== "DRAFT") throw new Error("This activity has already been published.");

      const title = typeof params.title === "string" ? params.title.trim() : undefined;
      const timeLimitSeconds =
        typeof params.timeLimitSeconds === "number" && Number.isFinite(params.timeLimitSeconds)
          ? Math.max(0, Math.min(8 * 60 * 60, Math.trunc(params.timeLimitSeconds)))
          : params.timeLimitSeconds === null
            ? null
            : undefined;

      const updated = activityDb.update(id, {
        ...(typeof title === "string" && title ? { title } : {}),
        ...(typeof timeLimitSeconds !== "undefined" ? { time_limit_seconds: timeLimitSeconds } : {}),
      });
      if (!updated) throw new Error("Failed to update activity.");
      return {
        activity: {
          id: updated.id,
          title: updated.title,
          prompt: updated.prompt || "",
          problems: JSON.parse(updated.problems),
          status: (updated.status as any) ?? "DRAFT",
          timeLimitSeconds: typeof updated.time_limit_seconds === "number" ? updated.time_limit_seconds : null,
          createdAt: updated.created_at,
        },
      };
    },
  },

  "activities.publish": {
    schema: z.object({ id: z.string().min(1).max(128) }).passthrough(),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const id = getString(params.id);
      if (!id) throw new Error("id is required.");
      const dbActivity = activityDb.findById(id);
      if (!dbActivity) throw new Error("Activity not found.");
      if ((dbActivity.status ?? "DRAFT") === "PUBLISHED") return { ok: true };
      activityDb.update(id, { status: "PUBLISHED" });
      return { ok: true };
    },
  },

  "activities.aiEdit": {
    schema: z
      .object({
        id: z.string().min(1).max(128),
        problemId: z.string().min(1).max(128),
        instruction: z.string().min(1).max(8000),
      })
      .passthrough(),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const id = getString(params.id);
      const problemId = getString(params.problemId);
      const instruction = getString(params.instruction);
      if (!id) throw new Error("id is required.");
      if (!problemId) throw new Error("problemId is required.");
      if (!instruction) throw new Error("instruction is required.");

      const dbActivity = activityDb.findById(id);
      if (!dbActivity) throw new Error("Activity not found.");
      if ((dbActivity.status ?? "DRAFT") !== "DRAFT") throw new Error("This activity has already been published.");

      let problems: any[] = [];
      try {
        const parsedProblems = JSON.parse(dbActivity.problems);
        problems = Array.isArray(parsedProblems) ? parsedProblems : [];
      } catch {
        throw new Error("Failed to load activity problems.");
      }

      const idx = problems.findIndex((p) => p && typeof p === "object" && (p as any).id === problemId);
      if (idx < 0) throw new Error("Problem not found.");

      const updatedProblem = await editDraftProblemWithAi({
        existing: problems[idx],
        instruction,
      });
      const nextProblems = [...problems];
      nextProblems[idx] = updatedProblem;

      const updated = activityDb.update(id, { problems: JSON.stringify(nextProblems) });
      if (!updated) throw new Error("Failed to update activity.");

      return {
        activity: {
          id: updated.id,
          title: updated.title,
          prompt: updated.prompt || "",
          problems: JSON.parse(updated.problems),
          status: (updated.status as any) ?? "DRAFT",
          timeLimitSeconds: typeof updated.time_limit_seconds === "number" ? updated.time_limit_seconds : null,
          createdAt: updated.created_at,
        },
      };
    },
  },

  "judge.run": {
    schema: z
      .object({
        language: ActivityLanguageSchema,
        code: z.string().min(1).max(200_000).optional(),
        files: z.record(z.string(), z.string()).optional(),
        mainClass: z.string().min(1).max(256).optional(),
        stdin: z.string().max(50_000).optional(),
      })
      .passthrough()
      .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const { code, language, files, mainClass, stdin } = params;

      const langParsed = ActivityLanguageSchema.safeParse(language);
      if (!langParsed.success) throw new Error("Invalid language.");
      const lang = langParsed.data;
      if (!isLanguageSupportedForExecution(lang)) throw new Error(`Language "${lang}" is not supported for /run yet.`);
      const profile = getLanguageProfile(lang);
      if (!profile.executionAdapter) throw new Error(`No execution adapter configured for "${lang}".`);

      const maxTotalCodeLength = 200_000; // 200KB
      const maxStdinLength = 50_000; // 50KB
      const maxFileCount = lang === "python" ? 20 : lang === "cpp" ? 40 : 12;
      const filenamePattern =
        lang === "python"
          ? /^[A-Za-z_][A-Za-z0-9_]*\.py$/
          : lang === "cpp"
            ? /^[A-Za-z_][A-Za-z0-9_]*\.(?:cpp|h|hpp)$/
            : lang === "sql"
              ? /^[A-Za-z_][A-Za-z0-9_]*\.sql$/
              : /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

      let safeStdin: string | undefined = undefined;
      if (typeof stdin !== "undefined") {
        if (typeof stdin !== "string") throw new Error("stdin must be a string.");
        if (stdin.length > maxStdinLength) throw new Error(`stdin exceeds maximum length of ${maxStdinLength} characters.`);
        safeStdin = stdin;
      }

      const runId = crypto.randomUUID();
      runDb.create(runId, "judge.run", {
        threadId: null,
        metaJson: safeJsonStringify({
          language: lang,
          kind: files && typeof files === "object" ? "files" : "code",
        }),
      });

      if (files && typeof files === "object") {
        const entries = Object.entries(files as Record<string, unknown>);
        if (entries.length === 0) throw new Error("files must be a non-empty object.");
        if (entries.length > maxFileCount) throw new Error(`Too many files. Max is ${maxFileCount}.`);

        let totalLen = safeStdin?.length ?? 0;
        const safeFiles: Record<string, string> = {};
        for (const [filename, source] of entries) {
          if (typeof filename !== "string" || !filenamePattern.test(filename)) {
            throw new Error(`Invalid filename "${String(filename)}".`);
          }
          if (typeof source !== "string" || !source.trim()) {
            throw new Error(`File "${filename}" must be a non-empty string.`);
          }
          totalLen += source.length;
          if (totalLen > maxTotalCodeLength) {
            throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
          }
          safeFiles[filename] = source;
        }

        if (lang === "python") {
          const hasMain = entries.some(([filename]) => filename === "main.py");
          if (!hasMain) throw new Error('Python /run requires a "main.py" file.');
        }
        if (lang === "cpp") {
          const hasMain = entries.some(([filename]) => filename === "main.cpp");
          if (!hasMain) throw new Error('C++ /run requires a "main.cpp" file.');
        }
        if (lang === "sql") {
          throw new Error('SQL does not support /run yet. Use /submit (Run tests).');
        }

        const execReq: {
          kind: "files";
          files: Record<string, string>;
          mainClass?: string;
          stdin?: string;
        } = { kind: "files", files: safeFiles };
        if (typeof mainClass === "string" && mainClass.trim()) execReq.mainClass = mainClass.trim();
        if (typeof safeStdin === "string") execReq.stdin = safeStdin;

        const result = await profile.executionAdapter.run(execReq);
        try {
          runEventDb.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
          runDb.finish(runId, "succeeded");
        } catch {
          // ignore
        }
        return { stdout: result.stdout, stderr: result.stderr, runId };
      }

      if (typeof code !== "string" || !code.trim()) {
        throw new Error("Provide either code (string) or files (object).");
      }
      const total = code.length + (safeStdin?.length ?? 0);
      if (total > maxTotalCodeLength) throw new Error(`Code exceeds maximum length of ${maxTotalCodeLength} characters.`);

      const execReq: { kind: "code"; code: string; stdin?: string } = { kind: "code", code };
      if (typeof safeStdin === "string") execReq.stdin = safeStdin;
      const result = await profile.executionAdapter.run(execReq);
      try {
        runEventDb.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
        runDb.finish(runId, "succeeded");
      } catch {
        // ignore
      }
      return { stdout: result.stdout, stderr: result.stderr, runId };
    },
  },

  "judge.submit": {
    schema: z
      .object({
        language: ActivityLanguageSchema.optional(),
        testSuite: z.string().min(1).max(200_000),
        code: z.string().min(1).max(200_000).optional(),
        files: z.record(z.string(), z.string()).optional(),
        activityId: z.string().min(1).max(128).optional(),
        problemId: z.string().min(1).max(128).optional(),
      })
      .passthrough()
      .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
    handler: async (paramsRaw) => {
      const params = requireParams(paramsRaw);
      const { code, testSuite, activityId, problemId, files, language } = params;

      if (typeof testSuite !== "string" || !testSuite.trim()) {
        throw new Error("testSuite is required for graded execution. Use /run for code-only execution.");
      }

      const langParsed = ActivityLanguageSchema.safeParse(language ?? "java");
      if (!langParsed.success) throw new Error("Invalid language.");
      const lang = langParsed.data;
      if (!isLanguageSupportedForJudge(lang)) throw new Error(`Language "${lang}" is not supported for /submit yet.`);
      const profile = getLanguageProfile(lang);
      if (!profile.judgeAdapter) throw new Error(`No judge adapter configured for "${lang}".`);

      const maxTotalCodeLength = 200_000; // 200KB
      const maxFileCount = lang === "python" ? 30 : lang === "cpp" ? 50 : 16;
      const filenamePattern =
        lang === "python"
          ? /^[A-Za-z_][A-Za-z0-9_]*\.py$/
          : lang === "cpp"
            ? /^[A-Za-z_][A-Za-z0-9_]*\.(?:cpp|h|hpp)$/
            : lang === "sql"
              ? /^[A-Za-z_][A-Za-z0-9_]*\.sql$/
              : /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

      const runId = crypto.randomUUID();
      runDb.create(runId, "judge.submit", {
        threadId: null,
        metaJson: safeJsonStringify({
          language: lang,
          kind: files && typeof files === "object" ? "files" : "code",
          activityId: typeof activityId === "string" ? activityId : null,
          problemId: typeof problemId === "string" ? problemId : null,
        }),
      });

      let result: any;
      let codeForPersistence: string | null = null;

      if (files && typeof files === "object") {
        const entries = Object.entries(files as Record<string, unknown>);
        if (entries.length === 0) throw new Error("files must be a non-empty object.");
        if (entries.length > maxFileCount) throw new Error(`Too many files. Max is ${maxFileCount}.`);

        let totalLen = testSuite.length;
        const safeFiles: Record<string, string> = {};
        for (const [filename, source] of entries) {
          if (typeof filename !== "string" || !filenamePattern.test(filename)) {
            throw new Error(`Invalid filename "${String(filename)}".`);
          }
          if (typeof source !== "string" || !source.trim()) {
            throw new Error(`File "${filename}" must be a non-empty string.`);
          }
          totalLen += source.length;
          if (totalLen > maxTotalCodeLength) throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
          safeFiles[filename] = source;
        }

        if (lang === "python") {
          if (Object.prototype.hasOwnProperty.call(safeFiles, "test_solution.py")) {
            throw new Error('files must not include "test_solution.py".');
          }
          if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.py")) {
            throw new Error('Python /submit requires a "solution.py" file.');
          }
        }
        if (lang === "cpp") {
          if (Object.prototype.hasOwnProperty.call(safeFiles, "test.cpp")) {
            throw new Error('files must not include "test.cpp".');
          }
          if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.cpp")) {
            throw new Error('C++ /submit requires a "solution.cpp" file.');
          }
          const cppSources = Object.keys(safeFiles).filter((f) => f.endsWith(".cpp") && f !== "solution.cpp");
          if (cppSources.length > 0) {
            throw new Error(`C++ /submit supports "solution.cpp" plus optional headers only. Remove: ${cppSources.join(", ")}`);
          }
        }
        if (lang === "sql") {
          if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.sql")) {
            throw new Error('SQL /submit requires a "solution.sql" file.');
          }
          const extras = Object.keys(safeFiles).filter((f) => f !== "solution.sql");
          if (extras.length > 0) {
            throw new Error(`SQL /submit supports only solution.sql. Remove: ${extras.join(", ")}`);
          }
        }

        result = await profile.judgeAdapter.judge({ kind: "files", files: safeFiles, testSuite });
        codeForPersistence = JSON.stringify(safeFiles);
      } else {
        if (typeof code !== "string" || !code.trim()) {
          throw new Error("code is required non-empty string.");
        }
        if (code.length + testSuite.length > maxTotalCodeLength) {
          throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
        }
        result = await profile.judgeAdapter.judge({ kind: "code", code, testSuite });
        codeForPersistence = code;
      }

      // Persist submissions locally (workspace-scoped DB file).
      if (typeof activityId === "string" && typeof problemId === "string") {
        const dbActivity = activityDb.findById(activityId);
        if (dbActivity) {
          const totalTests = result.passedTests.length + result.failedTests.length;
          submissionDb.create(
            activityId,
            problemId,
            codeForPersistence ?? "",
            result.success,
            result.passedTests.length,
            totalTests,
            result.executionTimeMs
          );
        }
      }

      try {
        runEventDb.append(
          runId,
          1,
          "result",
          safeJsonStringify({
            success: Boolean(result?.success),
            passedTests: Array.isArray(result?.passedTests) ? result.passedTests : [],
            failedTests: Array.isArray(result?.failedTests) ? result.failedTests : [],
            executionTimeMs: typeof result?.executionTimeMs === "number" ? result.executionTimeMs : null,
            timedOut: typeof result?.timedOut === "boolean" ? result.timedOut : null,
            exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
          })
        );
        runDb.finish(runId, "succeeded");
      } catch {
        // ignore
      }

      return { ...result, runId };
    },
  },
};

async function handle(method: string, paramsRaw: unknown, contextRaw?: unknown): Promise<unknown> {
  const def = rpcHandlers[method];
  if (!def) {
    throw new Error(`Unknown method: ${method}`);
  }
  const validated = def.schema ? validateOrThrow(def.schema, paramsRaw) : paramsRaw;
  const context = isObject(contextRaw) ? contextRaw : {};
  const llmContext =
    isObject((context as any).llmRoutePlan) && typeof (context as any).llmRoutePlan.provider === "string"
      ? ((context as any).llmRoutePlan as ResolvedLlmRoutePlan)
      : isObject((context as any).llmSnapshot) && typeof (context as any).llmSnapshot.provider === "string"
        ? ((context as any).llmSnapshot as ResolvedLlmSnapshot)
        : null;
  return withResolvedLlmSnapshot(llmContext, () => def.handler(validated));
}

function onMessage(raw: unknown) {
  if (!isObject(raw)) return;
  const msg = raw as Partial<RpcRequest>;
  if (msg.type !== "req") return;
  if (typeof msg.id !== "string" || !msg.id) return;
  if (typeof msg.method !== "string" || !msg.method) return;

  Promise.resolve()
    .then(() => handle(msg.method!, msg.params, msg.context))
    .then((result) => replyOk(msg.id!, result))
    .catch((err) => replyErr(msg.id!, err));
}

function shutdown() {
  for (const [subId, sub] of generationSubs.entries()) {
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
    generationSubs.delete(subId);
  }
}

initializeDatabase();

process.on("message", onMessage);
process.on("disconnect", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("exit", shutdown);
