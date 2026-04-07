import type {
  ActivityListResponseDto,
  ActivityResponseDto,
  CreateThreadResponseDto,
  GenerateThreadResponseDto,
  GenerationProgressEvent,
  GenerationDiagnosticsDto,
  JudgeRunRequestDto,
  JudgeRunResultDto,
  JudgeSubmitRequestDto,
  JudgeSubmitResultDto,
  LlmControlStatus,
  LlmSettingsResponse,
  LocalLlmStatus,
  PostThreadMessageResponseDto,
  ResolvedLlmRoutePlan,
  ThreadDetailDto,
  ThreadListResponseDto,
} from "@codemm/shared-contracts";

export type LearningMode = "practice" | "guided";

export type GenerationSubscription = {
  subId?: string;
  runId?: string;
  unsubscribe: () => Promise<void>;
};

export type LlmStatusSubscription = {
  unsubscribe: () => Promise<void>;
};

export type CodemmBridge = {
  workspace?: {
    get?: () => Promise<{ workspaceDir: string; workspaceDataDir: string } | null>;
    choose?: () => Promise<{ ok: boolean; error?: string; workspaceDir?: string; workspaceDataDir?: string }>;
  };
  secrets?: {
    getLlmSettings?: () => Promise<LlmSettingsResponse>;
    setLlmSettings?: (args: {
      provider: string;
      apiKey?: string;
      model?: string | null;
      baseURL?: string | null;
      routingProfile?: LlmSettingsResponse["routingProfile"];
      roleModels?: Record<string, string>;
    }) => Promise<unknown>;
    clearLlmSettings?: () => Promise<unknown>;
  };
  llm?: {
    getStatus?: () => Promise<LlmControlStatus>;
    getRoutePlan?: () => Promise<ResolvedLlmRoutePlan | null>;
    ensureReady?: (args: {
      activateOnSuccess?: boolean;
      forcedModel?: string | null;
      useCase?: "general" | "dialogue" | "generation" | "edit";
    }) => Promise<{ ok?: boolean; ready?: unknown; status?: LocalLlmStatus; error?: { message?: string } }>;
    acquireLease?: (args: {
      reason: string;
      forcedModel?: string | null;
      useCase?: "general" | "dialogue" | "generation" | "edit";
    }) => Promise<{ ok?: boolean; snapshot?: unknown }>;
    releaseLease?: (args: { leaseId: string }) => Promise<{ ok?: boolean }>;
    subscribeStatus?: (args: { onEvent: (status: LocalLlmStatus) => void }) => Promise<LlmStatusSubscription>;
  };
  threads?: {
    create?: (args: { learning_mode?: LearningMode }) => Promise<CreateThreadResponseDto>;
    list?: (args: { limit?: number }) => Promise<ThreadListResponseDto>;
    get?: (args: { threadId: string }) => Promise<ThreadDetailDto>;
    setInstructions?: (args: { threadId: string; instructions_md: string | null }) => Promise<{ ok: true }>;
    postMessage?: (args: { threadId: string; message: string }) => Promise<PostThreadMessageResponseDto>;
    generate?: (args: { threadId: string; runId?: string }) => Promise<GenerateThreadResponseDto>;
    generateV2?: (args: { threadId: string; runId?: string }) => Promise<GenerateThreadResponseDto>;
    regenerateSlot?: (args: {
      threadId: string;
      slotIndex: number;
      strategy?: string;
    }) => Promise<GenerateThreadResponseDto>;
    repairFailedSlots?: (args: { threadId: string; runId?: string }) => Promise<GenerateThreadResponseDto>;
    getGenerationDiagnostics?: (args: {
      threadId: string;
      runId?: string;
      limit?: number;
    }) => Promise<GenerationDiagnosticsDto>;
    subscribeGeneration?: (args: {
      threadId: string;
      runId?: string;
      onEvent: (event: GenerationProgressEvent) => void;
    }) => Promise<GenerationSubscription>;
  };
  activities?: {
    list?: (args: { limit?: number }) => Promise<ActivityListResponseDto>;
    get?: (args: { id: string }) => Promise<ActivityResponseDto>;
    patch?: (args: { id: string; title?: string; timeLimitSeconds?: number | null }) => Promise<ActivityResponseDto>;
    publish?: (args: { id: string }) => Promise<{ ok: true }>;
    aiEdit?: (args: { id: string; problemId: string; instruction: string }) => Promise<ActivityResponseDto>;
  };
  judge?: {
    run?: (args: JudgeRunRequestDto) => Promise<JudgeRunResultDto>;
    submit?: (args: JudgeSubmitRequestDto) => Promise<JudgeSubmitResultDto>;
  };
};

declare global {
  interface Window {
    codemm?: CodemmBridge;
  }
}

export function maybeGetCodemmBridge(): CodemmBridge | null {
  if (typeof window === "undefined") return null;
  return window.codemm ?? null;
}

export function getCodemmBridge(): CodemmBridge {
  const bridge = maybeGetCodemmBridge();
  if (!bridge) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
  return bridge;
}
