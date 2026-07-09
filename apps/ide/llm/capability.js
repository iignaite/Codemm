/**
 * Model → capability inference for route plans built in the IDE process.
 *
 * MUST stay behaviorally identical to apps/backend/src/infra/llm/capability.ts.
 * The engine trusts capabilities stamped here (route.capability wins over its
 * own inference), so divergence silently misroutes roles.
 */

const OLLAMA_WEAK_MAX_BILLIONS = 3;
const OLLAMA_BALANCED_MAX_BILLIONS = 12;

function parseBillions(normalizedModel) {
  const tagMatch = /(?:^|:)(\d+(?:\.\d+)?)b\b/.exec(normalizedModel);
  const anyMatch = tagMatch ?? /(\d+(?:\.\d+)?)b\b/.exec(normalizedModel);
  return anyMatch?.[1] ? Number(anyMatch[1]) : Number.NaN;
}

function inferModelCapability(model, provider) {
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

module.exports = { inferModelCapability };
