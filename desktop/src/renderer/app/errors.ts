import { PLAN_LIMIT, SIGNED_OUT } from '../../shared/api';

/** What went wrong with a call, as far as the learner needs to know. */
export type Problem = 'signed-out' | 'plan-limit' | 'other';

export function problemOf(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(SIGNED_OUT)) return 'signed-out';
  return message.includes(PLAN_LIMIT) ? 'plan-limit' : 'other';
}

export const PLAN_LIMIT_TEXT = "Your agent's plan limit is reached. Try again later.";
