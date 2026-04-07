import type {
  CreateThreadResponseDto,
  GenerateThreadResponseDto,
  GenerationDiagnosticsDto,
  GenerationProgressEvent,
  PostThreadMessageResponseDto,
  ThreadDetailDto,
  ThreadListResponseDto,
  ThreadMessageDto,
  ThreadSummaryDto,
  UpdateThreadInstructionsResponseDto,
} from "@codemm/shared-contracts";
import { getCodemmBridge, type LearningMode } from "./codemmBridge";

export type ChatMessageRecord = Pick<ThreadMessageDto, "role" | "content">;
export type ThreadSummary = ThreadSummaryDto;
export type ThreadSession = ThreadDetailDto;
export type GenerationDiagnosticsState = GenerationDiagnosticsDto;

export const threadsClient = {
  create(args: { learning_mode?: LearningMode }) {
    const api = getCodemmBridge().threads;
    if (!api?.create) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.create(args) as Promise<CreateThreadResponseDto>;
  },
  list(args: { limit?: number }) {
    const api = getCodemmBridge().threads;
    if (!api?.list) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.list(args) as Promise<ThreadListResponseDto>;
  },
  get(args: { threadId: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.get) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.get(args) as Promise<ThreadSession>;
  },
  setInstructions(args: { threadId: string; instructions_md: string | null }) {
    const api = getCodemmBridge().threads;
    if (!api?.setInstructions) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.setInstructions(args) as Promise<UpdateThreadInstructionsResponseDto>;
  },
  postMessage(args: { threadId: string; message: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.postMessage) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.postMessage(args) as Promise<PostThreadMessageResponseDto>;
  },
  generate(args: { threadId: string; runId?: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.generate) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.generate(args) as Promise<GenerateThreadResponseDto>;
  },
  generateV2(args: { threadId: string; runId?: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.generateV2) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.generateV2(args) as Promise<GenerateThreadResponseDto>;
  },
  generateLatest(args: { threadId: string; runId?: string }) {
    const api = getCodemmBridge().threads;
    if (!api) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    if (typeof api.generateV2 === "function") {
      return api.generateV2(args) as Promise<GenerateThreadResponseDto>;
    }
    if (typeof api.generate === "function") {
      return api.generate(args) as Promise<GenerateThreadResponseDto>;
    }
    throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
  },
  regenerateSlot(args: { threadId: string; slotIndex: number; strategy?: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.regenerateSlot) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.regenerateSlot(args) as Promise<GenerateThreadResponseDto>;
  },
  repairFailedSlots(args: { threadId: string; runId?: string }) {
    const api = getCodemmBridge().threads;
    if (!api?.repairFailedSlots) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.repairFailedSlots(args) as Promise<GenerateThreadResponseDto>;
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
  subscribeGeneration(args: { threadId: string; runId?: string; onEvent: (event: GenerationProgressEvent) => void }) {
    const api = getCodemmBridge().threads;
    if (!api?.subscribeGeneration) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
    return api.subscribeGeneration(args);
  },
};
