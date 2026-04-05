import type {
  LlmCapability,
  LlmRole,
  LlmRoute,
  ResolvedLlmRoutePlan,
  ResolvedLlmSnapshot,
} from "./types";

const ROLE_ORDER: readonly LlmRole[] = ["dialogue", "skeleton", "tests", "reference", "repair", "edit", "wording"];

function normalizeModel(raw: unknown): string | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value ? value : undefined;
}

export function inferCapabilityFromModel(model: string | undefined, provider: string): LlmCapability {
  const normalized = normalizeModel(model)?.toLowerCase() ?? "";
  if (!normalized) return provider === "ollama" ? "weak" : "strong";
  if (provider !== "ollama") return "strong";

  const billionMatch = /(?:^|:)(\d+(?:\.\d+)?)b\b/.exec(normalized) ?? /(\d+(?:\.\d+)?)b\b/.exec(normalized);
  const size = billionMatch?.[1] ? Number(billionMatch[1]) : Number.NaN;
  if (Number.isFinite(size)) {
    if (size <= 3) return "weak";
    if (size < 12) return "balanced";
    return "strong";
  }

  if (normalized.includes("1.5b") || normalized.includes("3b")) return "weak";
  if (normalized.includes("7b") || normalized.includes("8b")) return "balanced";
  if (normalized.includes("13b") || normalized.includes("14b") || normalized.includes("32b")) return "strong";
  return provider === "ollama" ? "balanced" : "strong";
}

function normalizeRoute(provider: ResolvedLlmRoutePlan["provider"], route: LlmRoute | undefined, defaultModel?: string): LlmRoute {
  const model = normalizeModel(route?.model) ?? normalizeModel(defaultModel);
  const fallbackChain = Array.isArray(route?.fallbackChain)
    ? route.fallbackChain.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  return {
    ...(model ? { model } : {}),
    capability: route?.capability ?? inferCapabilityFromModel(model, provider),
    ...(fallbackChain.length > 0 ? { fallbackChain } : {}),
    ...(route?.promptTemplateId ? { promptTemplateId: route.promptTemplateId } : {}),
  };
}

export function ensureRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): ResolvedLlmRoutePlan | null {
  if (!plan || !plan.provider) return null;
  const defaultModel = normalizeModel((plan as ResolvedLlmSnapshot).model) ?? normalizeModel(plan.defaultModel);
  const next: ResolvedLlmRoutePlan = {
    provider: plan.provider,
    ...(plan.apiKey !== undefined ? { apiKey: plan.apiKey } : {}),
    ...(plan.baseURL !== undefined ? { baseURL: plan.baseURL } : {}),
    ...(plan.revision !== undefined ? { revision: plan.revision } : {}),
    ...(plan.readiness !== undefined ? { readiness: plan.readiness } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(plan.routingProfile ? { routingProfile: plan.routingProfile } : {}),
  };

  const modelsByRole: Partial<Record<LlmRole, LlmRoute>> = {};
  for (const role of ROLE_ORDER) {
    const route = normalizeRoute(plan.provider, plan.modelsByRole?.[role], defaultModel);
    if (route.model || route.capability || route.fallbackChain?.length) {
      modelsByRole[role] = route;
    }
  }
  if (Object.keys(modelsByRole).length > 0) next.modelsByRole = modelsByRole;
  return next;
}

export function getRouteForRole(
  plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null,
  role: LlmRole,
  opts?: { escalationIndex?: number }
): LlmRoute | null {
  const normalized = ensureRoutePlan(plan);
  if (!normalized) return null;
  const baseRoute = normalizeRoute(normalized.provider, normalized.modelsByRole?.[role], normalized.defaultModel);
  const escalationIndex = typeof opts?.escalationIndex === "number" ? Math.max(0, Math.floor(opts.escalationIndex)) : 0;
  if (escalationIndex <= 0) return baseRoute;

  const fallbackChain = Array.isArray(baseRoute.fallbackChain) ? baseRoute.fallbackChain : [];
  const escalatedModel = fallbackChain[escalationIndex - 1];
  if (!escalatedModel) return baseRoute;
  return {
    ...baseRoute,
    model: escalatedModel,
    capability: inferCapabilityFromModel(escalatedModel, normalized.provider),
  };
}

export function summarizeRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): Record<string, unknown> | null {
  const normalized = ensureRoutePlan(plan);
  if (!normalized) return null;
  const modelsByRole: Record<string, unknown> = {};
  for (const role of ROLE_ORDER) {
    const route = getRouteForRole(normalized, role);
    if (!route || (!route.model && !route.capability)) continue;
    modelsByRole[role] = {
      ...(route.model ? { model: route.model } : {}),
      ...(route.capability ? { capability: route.capability } : {}),
      ...(Array.isArray(route.fallbackChain) && route.fallbackChain.length > 0 ? { fallbackChain: route.fallbackChain } : {}),
    };
  }
  return {
    provider: normalized.provider,
    ...(normalized.baseURL ? { baseURL: normalized.baseURL } : {}),
    ...(normalized.revision ? { revision: normalized.revision } : {}),
    ...(normalized.routingProfile ? { routingProfile: normalized.routingProfile } : {}),
    ...(normalized.defaultModel ? { defaultModel: normalized.defaultModel } : {}),
    modelsByRole,
  };
}
