import type {
  LlmCapability,
  LlmRole,
  LlmRoute,
  ResolvedLlmRoutePlan,
  ResolvedLlmSnapshot,
} from "../../llm/types";

export interface RuntimePlugin {
  id: string;
  normalizeRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): ResolvedLlmRoutePlan | null;
  summarizeRoutePlan(plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null): Record<string, unknown> | null;
  inferCapability(model: string | undefined, provider: string): LlmCapability;
  getRouteForRole(
    plan: ResolvedLlmRoutePlan | ResolvedLlmSnapshot | null,
    role: LlmRole,
    opts?: { escalationIndex?: number }
  ): LlmRoute | null;
}
