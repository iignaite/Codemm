import type { LlmCapability } from "./types";

/**
 * Single source of truth for model → capability inference in the engine.
 *
 * Cloud-provider models are treated as "strong". Ollama models are tiered by
 * parameter count parsed from the model tag.
 *
 * MUST stay behaviorally identical to apps/ide/llm/capability.js (the IDE
 * builds route plans in a separate JS process and cannot import this module).
 */

/** Parameter-count tiers for local models, in billions. */
export const OLLAMA_WEAK_MAX_BILLIONS = 3;
export const OLLAMA_BALANCED_MAX_BILLIONS = 12;

function parseBillions(normalizedModel: string): number {
  // Prefer the size in the tag segment (after ":" or at the start) so a size
  // embedded in the family name (e.g. "yi1.5b-coder:34b") does not win.
  const tagMatch = /(?:^|:)(\d+(?:\.\d+)?)b\b/.exec(normalizedModel);
  const anyMatch = tagMatch ?? /(\d+(?:\.\d+)?)b\b/.exec(normalizedModel);
  return anyMatch?.[1] ? Number(anyMatch[1]) : Number.NaN;
}

export function inferModelCapability(model: string | undefined | null, provider: string): LlmCapability {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!normalized) return provider === "ollama" ? "weak" : "strong";
  if (provider !== "ollama") return "strong";

  const size = parseBillions(normalized);
  if (Number.isFinite(size)) {
    if (size <= OLLAMA_WEAK_MAX_BILLIONS) return "weak";
    if (size < OLLAMA_BALANCED_MAX_BILLIONS) return "balanced";
    return "strong";
  }
  return "balanced";
}
