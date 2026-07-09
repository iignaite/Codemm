import { createGeminiCompletion, hasGeminiApiKey } from "../../llm/adapters/gemini";
import type { ProviderPlugin } from "./ProviderPlugin";

export const geminiProviderPlugin: ProviderPlugin = {
  id: "gemini",
  matchesResolvedProvider(snapshotOrEnv) {
    return String((snapshotOrEnv as { provider?: unknown } | null)?.provider ?? "").trim().toLowerCase() === "gemini";
  },
  isConfigured(snapshot) {
    if (snapshot?.provider === "gemini") {
      return Boolean(snapshot.apiKey && String(snapshot.apiKey).trim());
    }
    return hasGeminiApiKey();
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
    if (snapshot?.provider === "gemini" && snapshot.apiKey) {
      return createGeminiCompletion(request, {
        apiKey: snapshot.apiKey,
        ...(snapshot.baseURL ? { baseURL: snapshot.baseURL } : {}),
      });
    }
    return createGeminiCompletion(request);
  },
  getHealth(snapshot) {
    return { configured: this.isConfigured(snapshot), ready: true };
  },
};
