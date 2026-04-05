import { createOllamaCompletion, hasOllamaModelConfigured } from "../../llm/adapters/ollama";
import type { ProviderPlugin } from "./ProviderPlugin";

export const ollamaProviderPlugin: ProviderPlugin = {
  id: "ollama",
  matchesResolvedProvider(snapshotOrEnv) {
    return String((snapshotOrEnv as { provider?: unknown } | null)?.provider ?? "").trim().toLowerCase() === "ollama";
  },
  isConfigured(snapshot) {
    if (snapshot?.provider === "ollama") {
      return snapshot.readiness === "READY" && Boolean(snapshot.defaultModel || snapshot.modelsByRole?.dialogue?.model);
    }
    return hasOllamaModelConfigured();
  },
  resolveModel({ opts, snapshot, route }) {
    const model = opts.model ?? route?.model ?? snapshot?.defaultModel;
    return {
      ...(model ? { model } : {}),
      ...(Array.isArray(route?.fallbackChain) ? { fallbackChain: route.fallbackChain } : {}),
    };
  },
  createCompletion({ opts, snapshot, route, resolvedModel }) {
    const request = resolvedModel && !opts.model ? { ...opts, model: resolvedModel } : opts;
    if (snapshot?.provider === "ollama") {
      return createOllamaCompletion(request, {
        ...(snapshot.baseURL ? { baseURL: snapshot.baseURL } : {}),
        ...(route?.model ? { model: route.model } : resolvedModel ? { model: resolvedModel } : {}),
      });
    }
    return createOllamaCompletion(request);
  },
  getHealth(snapshot) {
    return {
      configured: this.isConfigured(snapshot),
      ready: snapshot?.provider === "ollama" ? snapshot.readiness === "READY" : true,
      ...(snapshot ? { detail: { readiness: snapshot.readiness ?? null } } : {}),
    };
  },
};
