export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama";

export type CompletionOpts = {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export type CompletionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CompletionMeta = {
  provider: LlmProvider;
  model?: string;
  finishReason?: string;
  truncated?: boolean;
  usage?: CompletionUsage;
};

export type CompletionResult = {
  content: Array<{ type: "text"; text: string }>;
  meta?: CompletionMeta;
};
