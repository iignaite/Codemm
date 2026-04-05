import type { LlmProvider, LlmRole } from "@codemm/shared-contracts";

export type {
  LlmCapability,
  LlmProvider,
  LlmRole,
  LlmRoute,
  ResolvedLlmRoutePlan,
  ResolvedLlmSnapshot,
  RoutingProfile,
} from "@codemm/shared-contracts";

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
