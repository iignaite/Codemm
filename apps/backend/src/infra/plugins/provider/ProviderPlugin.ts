import type { CompletionOpts, CompletionResult, LlmProvider, LlmRoute, ResolvedLlmRoutePlan } from "../../llm/types";

export type ProviderPluginSnapshot = ResolvedLlmRoutePlan | null;

export type ProviderPluginHealth = {
  configured: boolean;
  ready?: boolean;
  detail?: unknown;
};

export type ProviderModelResolution = {
  model?: string;
  fallbackChain?: string[];
};

export type ProviderPluginModelArgs = {
  opts: CompletionOpts;
  snapshot: ProviderPluginSnapshot;
  route: LlmRoute | null;
};

export type ProviderPluginCompletionArgs = ProviderPluginModelArgs & {
  resolvedModel?: string;
};

export interface ProviderPlugin {
  id: LlmProvider;
  matchesResolvedProvider(snapshotOrEnv: { provider?: unknown } | unknown): boolean;
  isConfigured(snapshot: ProviderPluginSnapshot): boolean;
  resolveModel(args: ProviderPluginModelArgs): ProviderModelResolution;
  createCompletion(args: ProviderPluginCompletionArgs): Promise<CompletionResult>;
  getHealth?(snapshot: ProviderPluginSnapshot): ProviderPluginHealth;
}
