import { AGENT_FAILED, NO_AGENT, PLAN_LIMIT, REPAIR, SIGNED_OUT } from '../../shared/api';

/** What went wrong with a call, as far as the learner needs to know. */
export type Problem = 'connect' | 'plan-limit' | 'repair' | 'agent' | 'other';

export function problemOf(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(SIGNED_OUT) || message.includes(NO_AGENT)) return 'connect';
  if (message.includes(PLAN_LIMIT)) return 'plan-limit';
  if (message.startsWith(REPAIR)) return 'repair';
  return message.includes(AGENT_FAILED) ? 'agent' : 'other';
}

/** What the failure banner says (DESIGN §5). */
export const SAY: Record<Exclude<Problem, 'connect'>, string> = {
  'plan-limit': "Your agent's plan limit is reached. Try again later.",
  repair: "Codemm's records need a repair.",
  agent: "Codemm couldn't finish that. Try again.",
  other: "That didn't work. Try again.",
};

/** Core's repair guidance after a REPAIR code: safe text naming the damaged record and the fix. */
export const repairDetail = (error: unknown) => (error instanceof Error ? error.message.split('\n').slice(1).join(' ') : '');
