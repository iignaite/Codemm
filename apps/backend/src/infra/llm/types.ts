export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama";

export type LlmRole = "dialogue" | "skeleton" | "tests" | "reference" | "repair" | "edit" | "wording";

export type LlmCapability = "weak" | "balanced" | "strong";

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
  routingProfile?: "auto" | "fast_local" | "balanced_local" | "strong_local" | "custom";
  modelsByRole?: Partial<Record<LlmRole, LlmRoute>>;
};

// Backwards-compatible name for older call sites/tests while the route-plan
// rollout replaces single-model snapshots.
export type ResolvedLlmSnapshot = ResolvedLlmRoutePlan & {
  model?: string;
  leaseId?: string | null;
};

export type CompletionOpts = {
  system: string;
  user: string;
  model?: string;
  role?: LlmRole;
  temperature?: number;
  maxTokens?: number;
  runId?: string;
  slotIndex?: number;
  attempt?: number;
  fallbackChain?: string[];
};

export type CompletionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CompletionMeta = {
  provider: LlmProvider;
  model?: string;
  role?: LlmRole;
  finishReason?: string;
  truncated?: boolean;
  usage?: CompletionUsage;
};

export type CompletionResult = {
  content: Array<{ type: "text"; text: string }>;
  meta?: CompletionMeta;
};
