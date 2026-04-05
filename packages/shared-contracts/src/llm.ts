export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama";

export type LlmRole = "dialogue" | "skeleton" | "tests" | "reference" | "repair" | "edit" | "wording";

export type LlmCapability = "weak" | "balanced" | "strong";

export type RoutingProfile = "auto" | "fast_local" | "balanced_local" | "strong_local" | "custom";

export type LlmRoute = {
  model?: string;
  capability?: LlmCapability;
  fallbackChain?: string[];
  promptTemplateId?: string;
};

export type ResolvedLlmRoutePlan = {
  provider: LlmProvider;
  apiKey?: string | null;
  baseURL?: string | null;
  revision?: string | null;
  readiness?: string;
  defaultModel?: string;
  routingProfile?: RoutingProfile;
  modelsByRole?: Partial<Record<LlmRole, LlmRoute>>;
};

export type ResolvedLlmSnapshot = ResolvedLlmRoutePlan & {
  model?: string;
  leaseId?: string | null;
};

export type LlmSettingsResponse = {
  configured: boolean;
  provider: string | null;
  model?: string | null;
  baseURL?: string | null;
  routingProfile?: RoutingProfile;
  roleModels?: Record<string, string> | null;
  updatedAt: string | null;
};

export type LocalLlmOperation = {
  id: string;
  kind: string;
  message: string;
  model?: string | null;
  startedAt: string;
  downloaded?: number;
  total?: number;
};

export type LocalLlmStatus = {
  state: string;
  operation: LocalLlmOperation | null;
  runtime: {
    binaryPath: string | null;
    version: string | null;
    baseURL: string | null;
    activeModel: string | null;
    revision: string | null;
    lastReadyAt: string | null;
    leaseCount: number;
    lastError: { code: string; message: string; detail?: unknown } | null;
  };
  updatedAt: string;
};

export type LlmControlStatus = {
  activeProvider: string | null;
  configured: boolean;
  local: LocalLlmStatus | null;
};
