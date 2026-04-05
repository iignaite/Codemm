import type { CompletionOpts, CompletionResult, LlmProvider, ResolvedLlmRoutePlan, ResolvedLlmSnapshot } from "./types";
import { createGeminiCompletion, hasGeminiApiKey } from "./adapters/gemini";
import { hasAnthropicApiKey } from "./adapters/anthropic";
import { hasOllamaModelConfigured } from "./adapters/ollama";
import { hasOpenAiApiKey, getOpenAiClient } from "./adapters/openai";
import { getResolvedLlmSnapshot } from "./executionContext";
import { ensureRoutePlan, getRouteForRole } from "./runtimeService";
import { findProviderPlugin, getProviderPlugin, listProviderPlugins } from "../plugins/provider";

function normalizeProvider(raw: unknown): LlmProvider | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "openai" || s === "oai") return "openai";
  if (s === "anthropic" || s === "claude") return "anthropic";
  if (s === "gemini" || s === "google") return "gemini";
  if (s === "ollama" || s === "local") return "ollama";
  if (s === "auto") return null;
  return null;
}

function getConfiguredProvider(): LlmProvider | null {
  const raw = process.env.CODEX_PROVIDER ?? process.env.CODEMM_LLM_PROVIDER;
  return normalizeProvider(raw);
}

export function hasAnyLlmApiKey(): boolean {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const plugin = findProviderPlugin(snapshot);
  if (snapshot && snapshot.provider === "gemini") {
    return Boolean(snapshot.apiKey && snapshot.apiKey.trim());
  }
  if (plugin && plugin.id !== "ollama") return plugin.isConfigured(snapshot);
  return hasOpenAiApiKey() || hasAnthropicApiKey() || hasGeminiApiKey();
}

export function hasAnyLlmConfigured(): boolean {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const plugin = findProviderPlugin(snapshot);
  if (snapshot?.provider === "ollama") {
    const route = getRouteForRole(snapshot, "dialogue");
    return snapshot.readiness === "READY" && Boolean(route?.model && route.model.trim());
  }
  if (snapshot?.provider === "gemini") {
    return Boolean(snapshot.apiKey && snapshot.apiKey.trim());
  }
  if (plugin) return plugin.isConfigured(snapshot);

  return hasAnyLlmApiKey() || hasOllamaModelConfigured();
}

function resolveProviderOrThrow(): LlmProvider {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  if (snapshot?.provider) {
    const plugin = findProviderPlugin(snapshot);
    if (plugin) {
      const route = getRouteForRole(snapshot, "dialogue");
      const health = plugin.getHealth?.(snapshot) ?? { configured: plugin.isConfigured(snapshot) };
      if (!health.configured) {
        if (plugin.id === "ollama") {
          if (snapshot.readiness !== "READY") throw new Error("Local Ollama snapshot is not READY.");
          if (!(route?.model && String(route.model).trim())) throw new Error("Resolved Ollama snapshot is missing a model.");
        }
        throw new Error(`Resolved ${plugin.id} snapshot is not configured.`);
      }
      return plugin.id;
    }
    if (
      snapshot.provider === "gemini" &&
      !(snapshot.apiKey && String(snapshot.apiKey).trim())
    ) {
      throw new Error("Resolved gemini snapshot is missing an API key.");
    }
    return snapshot.provider;
  }

  const explicit = getConfiguredProvider();
  if (explicit === "openai") {
    if (!hasOpenAiApiKey()) {
      throw new Error(
        "Missing OpenAI API key. Set CODEX_API_KEY or OPENAI_API_KEY, or set CODEX_PROVIDER=anthropic|gemini."
      );
    }
    return "openai";
  }
  if (explicit === "anthropic") {
    if (!hasAnthropicApiKey()) {
      throw new Error("Missing Anthropic API key. Set ANTHROPIC_API_KEY, or set CODEX_PROVIDER=openai|gemini.");
    }
    return "anthropic";
  }
  if (explicit === "gemini") {
    if (!hasGeminiApiKey()) {
      throw new Error("Missing Gemini API key. Set GEMINI_API_KEY/GOOGLE_API_KEY, or set CODEX_PROVIDER=openai|anthropic.");
    }
    return "gemini";
  }
  if (explicit === "ollama") {
    if (!hasOllamaModelConfigured()) {
      throw new Error('Missing Ollama model. Set CODEMM_OLLAMA_MODEL (example: "qwen2.5-coder:7b") and ensure Ollama is running.');
    }
    return "ollama";
  }

  // Auto mode: choose the first available provider (one provider per process).
  for (const plugin of listProviderPlugins()) {
    if (plugin.id === "ollama") continue;
    if (plugin.isConfigured(null)) return plugin.id;
  }
  if (hasGeminiApiKey()) return "gemini";
  if (getProviderPlugin("ollama")?.isConfigured(null)) return "ollama";
  if (hasOllamaModelConfigured()) return "ollama";

  throw new Error(
    'No LLM configured. Set one of: CODEX_API_KEY/OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, or use Ollama by setting CODEX_PROVIDER=ollama and CODEMM_OLLAMA_MODEL.'
  );
}

export async function createCodemmCompletion(opts: CompletionOpts): Promise<CompletionResult> {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const provider = resolveProviderOrThrow();
  const role = opts.role ?? "dialogue";
  const route = getRouteForRole(snapshot, role, {
    escalationIndex: typeof opts.attempt === "number" ? Math.max(0, opts.attempt - 1) : 0,
  });
  if (provider === "gemini") {
    const resolvedModel = opts.model ?? route?.model ?? snapshot?.defaultModel;
    const resolvedOpts: CompletionOpts = resolvedModel && !opts.model ? { ...opts, model: resolvedModel } : opts;
    if (snapshot?.provider === "gemini" && snapshot.apiKey) {
      return createGeminiCompletion(resolvedOpts, {
        apiKey: snapshot.apiKey,
        ...(snapshot.baseURL ? { baseURL: snapshot.baseURL } : {}),
      });
    }
    return createGeminiCompletion(resolvedOpts);
  }
  const plugin = getProviderPlugin(provider);
  if (plugin) {
    const { model: resolvedModel } = plugin.resolveModel({ opts, snapshot, route });
    return plugin.createCompletion({
      opts,
      snapshot,
      route,
      ...(resolvedModel ? { resolvedModel } : {}),
    });
  }
  const fallbackModel = opts.model ?? route?.model ?? snapshot?.defaultModel;
  const fallbackOpts: CompletionOpts = fallbackModel && !opts.model ? { ...opts, model: fallbackModel } : opts;
  return createGeminiCompletion(fallbackOpts);
}

export function getResolvedSnapshotOrNull(): ResolvedLlmRoutePlan | null {
  return ensureRoutePlan(getResolvedLlmSnapshot());
}

// Backwards-compatible alias for older call sites.
export const createCodexCompletion = createCodemmCompletion;

// Backwards-compatible export for older code that directly asked for an OpenAI client.
export const getCodexClient = getOpenAiClient;
