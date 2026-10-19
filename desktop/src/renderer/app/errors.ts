import { AGENT_FAILED, NO_AGENT, OFFLINE, PLAN_LIMIT, REPAIR, SIGNED_OUT, UNSTOPPABLE } from '../../shared/api';

/** What went wrong with a call, as far as the learner needs to know. */
export type Problem = 'connect' | 'plan-limit' | 'offline' | 'repair' | 'unstoppable' | 'agent' | 'other';

export function problemOf(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(SIGNED_OUT) || message.includes(NO_AGENT)) return 'connect';
  if (message.includes(PLAN_LIMIT)) return 'plan-limit';
  if (message.includes(OFFLINE)) return 'offline';
  if (message.startsWith(REPAIR)) return 'repair';
  if (message.includes(UNSTOPPABLE)) return 'unstoppable';
  return message.includes(AGENT_FAILED) ? 'agent' : 'other';
}

/** What the failure banner says (DESIGN §5). */
export const SAY: Record<Exclude<Problem, 'connect'>, string> = {
  'plan-limit': "Your agent's plan limit is reached. Try again later.",
  offline: "You're offline. Connect to the internet, then try again.",
  repair: "Codemm's records need a repair.",
  unstoppable: "Codemm couldn't stop your agent. Quit Codemm to stop it.",
  agent: "Codemm couldn't finish that. Try again.",
  other: "That didn't work. Try again.",
};

/** A sentence meant for a learner: whole, and with no path, command or tool name, which core's messages for agents carry. */
const plain = (text: string) => /[.!?]$/.test(text) && !/[`/\\_]/.test(text);

/**
 * What a failure says. Codemm's words for a known problem; for any other, the message main let through, if it is a
 * plain sentence (its first line only: a longer one can list exercises), else the generic one. An error made in the
 * window itself, a bug, never passed main's filter, so it is never shown.
 */
export function sayOf(error: unknown, problem: Exclude<Problem, 'connect'>): string {
  if (problem !== 'other') return SAY[problem];
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError) return SAY.other;
  const first = (error instanceof Error ? error.message : '').split('\n')[0].trim().replace(/:$/, '.');
  return plain(first) ? first : SAY.other;
}

/** Core's repair guidance after a REPAIR code: safe text naming the damaged record and the fix. */
export const repairDetail = (error: unknown) => (error instanceof Error ? error.message.split('\n').slice(1).join(' ') : '');
