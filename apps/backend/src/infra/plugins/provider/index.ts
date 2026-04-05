import type { LlmProvider, ResolvedLlmRoutePlan } from "../../llm/types";
import type { ProviderPlugin } from "./ProviderPlugin";
import { anthropicProviderPlugin } from "./anthropicProvider";
import { ollamaProviderPlugin } from "./ollamaProvider";
import { openaiProviderPlugin } from "./openaiProvider";

const providerPlugins: ProviderPlugin[] = [openaiProviderPlugin, anthropicProviderPlugin, ollamaProviderPlugin];

export function listProviderPlugins(): ProviderPlugin[] {
  return [...providerPlugins];
}

export function getProviderPlugin(provider: LlmProvider | null | undefined): ProviderPlugin | null {
  if (!provider) return null;
  return providerPlugins.find((plugin) => plugin.id === provider) ?? null;
}

export function findProviderPlugin(snapshot: ResolvedLlmRoutePlan | { provider?: unknown } | null | undefined): ProviderPlugin | null {
  if (!snapshot) return null;
  return providerPlugins.find((plugin) => plugin.matchesResolvedProvider(snapshot)) ?? null;
}
