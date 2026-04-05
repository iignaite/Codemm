import type {
  GenerationProgressEvent,
  LlmControlStatus,
  LlmSettingsResponse,
  LocalLlmStatus,
  ResolvedLlmRoutePlan,
} from "@codemm/shared-contracts";

export type LearningMode = "practice" | "guided";

export type GenerationSubscription = {
  subId?: string;
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
    create?: (args: { learning_mode?: LearningMode }) => Promise<unknown>;
    list?: (args: { limit?: number }) => Promise<unknown>;
    get?: (args: { threadId: string }) => Promise<unknown>;
    setInstructions?: (args: { threadId: string; instructions_md: string | null }) => Promise<unknown>;
    postMessage?: (args: { threadId: string; message: string }) => Promise<unknown>;
    generate?: (args: { threadId: string }) => Promise<unknown>;
    generateV2?: (args: { threadId: string }) => Promise<unknown>;
    regenerateSlot?: (args: { threadId: string; slotIndex: number; strategy?: string }) => Promise<unknown>;
    getGenerationDiagnostics?: (args: { threadId: string; runId?: string; limit?: number }) => Promise<unknown>;
    subscribeGeneration?: (args: {
      threadId: string;
      onEvent: (event: GenerationProgressEvent) => void;
    }) => Promise<GenerationSubscription>;
  };
  activities?: {
    list?: (args: { limit?: number }) => Promise<unknown>;
    get?: (args: { id: string }) => Promise<unknown>;
    patch?: (args: { id: string; title?: string; timeLimitSeconds?: number | null }) => Promise<unknown>;
    publish?: (args: { id: string }) => Promise<unknown>;
    aiEdit?: (args: { id: string; problemId: string; instruction: string }) => Promise<unknown>;
  };
  judge?: {
    run?: (args: {
      language: "java" | "python" | "cpp" | "sql";
      code?: string;
      files?: Record<string, string>;
      mainClass?: string;
      stdin?: string;
    }) => Promise<unknown>;
    submit?: (args: {
      language?: "java" | "python" | "cpp" | "sql";
      testSuite: string;
      code?: string;
      files?: Record<string, string>;
      activityId?: string;
      problemId?: string;
    }) => Promise<unknown>;
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
