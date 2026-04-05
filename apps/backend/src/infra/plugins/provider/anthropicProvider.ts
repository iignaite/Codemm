import { createAnthropicCompletion, hasAnthropicApiKey } from "../../llm/adapters/anthropic";
import type { ProviderPlugin } from "./ProviderPlugin";

export const anthropicProviderPlugin: ProviderPlugin = {
  id: "anthropic",
  matchesResolvedProvider(snapshotOrEnv) {
    return String((snapshotOrEnv as { provider?: unknown } | null)?.provider ?? "").trim().toLowerCase() === "anthropic";
  },
  isConfigured(snapshot) {
    if (snapshot?.provider === "anthropic") {
      return Boolean(snapshot.apiKey && String(snapshot.apiKey).trim());
    }
    return hasAnthropicApiKey();
  },
  resolveModel({ opts, snapshot, route }) {
    const model = opts.model ?? route?.model ?? snapshot?.defaultModel;
    return {
      ...(model ? { model } : {}),
      ...(Array.isArray(route?.fallbackChain) ? { fallbackChain: route.fallbackChain } : {}),
    };
  },
  createCompletion({ opts, snapshot, resolvedModel }) {
    const request = resolvedModel && !opts.model ? { ...opts, model: resolvedModel } : opts;
    if (snapshot?.provider === "anthropic" && snapshot.apiKey) {
      return createAnthropicCompletion(request, {
        apiKey: snapshot.apiKey,
        ...(snapshot.baseURL ? { baseURL: snapshot.baseURL } : {}),
      });
    }
    return createAnthropicCompletion(request);
  },
  getHealth(snapshot) {
    return { configured: this.isConfigured(snapshot), ready: true };
  },
};
