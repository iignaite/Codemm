import type {
  LlmCapability,
  LlmRole,
  LlmRoute,
  ResolvedLlmRoutePlan,
  ResolvedLlmSnapshot,
} from "./types";
import { getDefaultRuntimePlugin } from "../plugins/runtime";

export function inferCapabilityFromModel(model: string | undefined, provider: string): LlmCapability {
  return getDefaultRuntimePlugin().inferCapability(model, provider);
}

export function ensureRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): ResolvedLlmRoutePlan | null {
  return getDefaultRuntimePlugin().normalizeRoutePlan(plan);
}

export function getRouteForRole(
  plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null,
  role: LlmRole,
  opts?: { escalationIndex?: number }
): LlmRoute | null {
  return getDefaultRuntimePlugin().getRouteForRole(plan, role, opts);
}

export function summarizeRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): Record<string, unknown> | null {
  return getDefaultRuntimePlugin().summarizeRoutePlan(plan);
}
