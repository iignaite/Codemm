import type { CompletionOpts, CompletionResult, LlmProvider, ResolvedLlmRoutePlan } from "./types";
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

/** Error shown when a provider is explicitly requested via env but not configured. */
const EXPLICIT_PROVIDER_ERRORS: Record<LlmProvider, string> = {
  openai: "Missing OpenAI API key. Set CODEX_API_KEY or OPENAI_API_KEY, or set CODEX_PROVIDER=anthropic|gemini.",
  anthropic: "Missing Anthropic API key. Set ANTHROPIC_API_KEY, or set CODEX_PROVIDER=openai|gemini.",
  gemini: "Missing Gemini API key. Set GEMINI_API_KEY/GOOGLE_API_KEY, or set CODEX_PROVIDER=openai|anthropic.",
  ollama: 'Missing Ollama model. Set CODEMM_OLLAMA_MODEL (example: "qwen2.5-coder:7b") and ensure Ollama is running.',
};

export function hasAnyLlmApiKey(): boolean {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const plugin = findProviderPlugin(snapshot);
  if (plugin && plugin.id !== "ollama") return plugin.isConfigured(snapshot);
  return listProviderPlugins().some((candidate) => candidate.id !== "ollama" && candidate.isConfigured(null));
}

export function hasAnyLlmConfigured(): boolean {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const plugin = findProviderPlugin(snapshot);
  if (snapshot?.provider === "ollama") {
    const route = getRouteForRole(snapshot, "dialogue");
    return snapshot.readiness === "READY" && Boolean(route?.model && route.model.trim());
  }
  if (plugin) return plugin.isConfigured(snapshot);

  return listProviderPlugins().some((candidate) => candidate.isConfigured(null));
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
    return snapshot.provider;
  }

  const explicit = getConfiguredProvider();
  if (explicit) {
    const plugin = getProviderPlugin(explicit);
    if (!plugin?.isConfigured(null)) {
      throw new Error(EXPLICIT_PROVIDER_ERRORS[explicit]);
    }
    return explicit;
  }

  // Auto mode: first configured provider in registry order (one provider per process).
  for (const plugin of listProviderPlugins()) {
    if (plugin.isConfigured(null)) return plugin.id;
  }

  throw new Error(
    'No LLM configured. Open LLM Settings and save a cloud provider API key, or click "Use Local Model" to set up Ollama.'
  );
}

export async function createCodemmCompletion(opts: CompletionOpts): Promise<CompletionResult> {
  const snapshot = ensureRoutePlan(getResolvedLlmSnapshot());
  const provider = resolveProviderOrThrow();
  const role = opts.role ?? "dialogue";
  const route = getRouteForRole(snapshot, role, {
    escalationIndex: typeof opts.attempt === "number" ? Math.max(0, opts.attempt - 1) : 0,
  });
  const plugin = getProviderPlugin(provider);
  if (!plugin) {
    throw new Error(`No provider plugin registered for "${provider}".`);
  }
  const { model: resolvedModel } = plugin.resolveModel({ opts, snapshot, route });
  return plugin.createCompletion({
    opts,
    snapshot,
    route,
    ...(resolvedModel ? { resolvedModel } : {}),
  });
}

export function getResolvedSnapshotOrNull(): ResolvedLlmRoutePlan | null {
  return ensureRoutePlan(getResolvedLlmSnapshot());
}
