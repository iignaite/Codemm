import type { GenerationProgressEvent } from "@codemm/shared-contracts";
import { getCodemmBridge, type LearningMode } from "./codemmBridge";

export type ChatMessageRecord = {
  role: "user" | "assistant";
  content: string;
};

export type ThreadSummary = {
  id: string;
  state: string;
  learning_mode: LearningMode;
  created_at: string;
  updated_at: string;
  activity_id: string | null;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
};

export type ThreadSession = {
  id: string;
  state: string;
  learning_mode: LearningMode;
  instructions_md?: string | null;
  messages?: ChatMessageRecord[];
  [key: string]: unknown;
};

export type GenerationDiagnosticsState = {
  threadId: string;
  runId: string | null;
  run: {
    id: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    meta?: {
      routePlan?: {
        provider?: string;
        defaultModel?: string;
        routingProfile?: string;
        modelsByRole?: Record<string, { model?: string; capability?: string }>;
      } | null;
    } | null;
  } | null;
  summary: {
    totalAttempts: number;
    failedAttempts: number;
    successfulAttempts: number;
    finalFailureKind?: string;
    llmMs?: number;
    dockerMs?: number;
    totalStageMs?: number;
  };
  latestFailure: {
    slotIndex: number;
    attempt: number;
    kind: string;
    message: string;
    remediation: string[];
    final: boolean;
    stage?: string;
    terminationReason?: string;
  } | null;
  stageTimeline: Array<{
    ts: string;
    slotIndex: number;
    stage: string;
    attempt: number;
    status: "started" | "success" | "failed" | "escalated" | "terminal";
    routeRole?: string;
    provider?: string;
    model?: string;
    durationMs?: number;
    message?: string;
    failureKind?: string;
    terminationReason?: string;
    fromModel?: string;
    toModel?: string;
    reason?: string;
  }>;
  routeSelections: Array<{
    ts: string;
    slotIndex: number;
    routeRole: string;
    provider?: string;
    model?: string;
    capability?: string;
  }>;
  errors: Array<{ seq: number; message: string; createdAt: string }>;
};

export const threadsClient = {
  create(args: { learning_mode?: LearningMode }) {
    const api = getCodemmBridge().threads;
    if (!api?.create) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.create(args);
  },
  list(args: { limit?: number }) {
    const api = getCodemmBridge().threads;
    if (!api?.list) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.list(args) as Promise<{ threads: ThreadSummary[] }>;
  },
  get(args: { threadId: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.get) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.get(args) as Promise<ThreadSession & Record<string, unknown>>;
  },
  setInstructions(args: { threadId: string; instructions_md: string | null }) {
    const api = getCodemmBridge().threads;
    if (!api?.setInstructions) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.setInstructions(args);
  },
  postMessage(args: { threadId: string; message: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.postMessage) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.postMessage(args);
  },
  generate(args: { threadId: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.generate) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.generate(args);
  },
  generateV2(args: { threadId: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.generateV2) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.generateV2(args);
  },
  generateLatest(args: { threadId: string }) {
    const api = getCodemmBridge().threads;
    if (!api) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    if (typeof api.generateV2 === "function") {
      return api.generateV2(args);
    }
    if (typeof api.generate === "function") {
      return api.generate(args);
    }
    throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
  },
  regenerateSlot(args: { threadId: string; slotIndex: number; strategy?: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.regenerateSlot) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.regenerateSlot(args);
  },
  getGenerationDiagnostics(args: { threadId: string; runId?: string | null; limit?: number }) {
    const api = getCodemmBridge().threads;
    if (!api?.getGenerationDiagnostics) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.getGenerationDiagnostics({
      threadId: args.threadId,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    }) as Promise<GenerationDiagnosticsState>;
  },
  subscribeGeneration(args: { threadId: string; onEvent: (event: GenerationProgressEvent) => void }) {
    const api = getCodemmBridge().threads;
    if (!api?.subscribeGeneration) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.subscribeGeneration(args);
  },
};
