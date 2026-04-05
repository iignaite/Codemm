import { createOpenAiCompletion, hasOpenAiApiKey } from "../../llm/adapters/openai";
import type { ProviderPlugin } from "./ProviderPlugin";

export const openaiProviderPlugin: ProviderPlugin = {
  id: "openai",
  matchesResolvedProvider(snapshotOrEnv) {
    return String((snapshotOrEnv as { provider?: unknown } | null)?.provider ?? "").trim().toLowerCase() === "openai";
  },
  isConfigured(snapshot) {
    if (snapshot?.provider === "openai") {
      return Boolean(snapshot.apiKey && String(snapshot.apiKey).trim());
    }
    return hasOpenAiApiKey();
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
    if (snapshot?.provider === "openai" && snapshot.apiKey) {
      return createOpenAiCompletion(request, {
        apiKey: snapshot.apiKey,
        ...(snapshot.baseURL ? { baseURL: snapshot.baseURL } : {}),
      });
    }
    return createOpenAiCompletion(request);
  },
  getHealth(snapshot) {
    return { configured: this.isConfigured(snapshot), ready: true };
  },
};
