// The models a learner may choose per agent (O6): only bench-tested ones
// (docs/bench/results.md), with the recommended one marked and chosen by default.
import type { AgentId, ModelChoice } from './api';
import table from './models.json';

export function modelChoices(agent: AgentId): ModelChoice[] {
  const t = table[agent];
  return t ? t.models.map((m) => ({ ...m, recommended: m.id === t.recommended })) : [];
}

/** The saved choice while it is still tested, otherwise the recommended model; null for an agent with no choices. */
export function modelFor(agent: AgentId, saved?: string): string | null {
  const choices = modelChoices(agent);
  return (choices.find((m) => m.id === saved) ?? choices.find((m) => m.recommended))?.id ?? null;
}
