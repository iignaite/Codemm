// What a failure may say outside the main process (DESIGN §2.2, D4). A raw
// error, such as a file system error, can name a hidden file, so only these
// pass: Codemm's error codes, core's learner-safe CodemmError, and the
// desktop's own SafeError. Everything else says INTERNAL, and the log gets
// the error's kind and Node code, never its message.
import { AGENT_FAILED, CHANGED, NO_AGENT, PLAN_LIMIT, SIGNED_OUT, UNSTOPPABLE } from '../shared/api';
import type { Fields } from './log';

/** An error whose message the desktop wrote for the learner. */
export class SafeError extends Error {
  override name = 'SafeError';
}

export const INTERNAL = "That didn't work. Try again.";
const CODES = [SIGNED_OUT, NO_AGENT, PLAN_LIMIT, AGENT_FAILED, CHANGED, UNSTOPPABLE];

const codeOf = (e: Error) => CODES.find((c) => e.message === c);
const fromCore = (e: Error) => e.name === 'CodemmError';

export function safeError(e: unknown): Error {
  if (!(e instanceof Error)) return new Error(INTERNAL);
  if (codeOf(e)) return new Error(codeOf(e));
  if (fromCore(e) || e instanceof SafeError) return new Error(e.message);
  return new Error(INTERNAL);
}

export function errorFields(e: unknown): Fields {
  if (!(e instanceof Error)) return { kind: 'thrown' };
  const code = codeOf(e);
  if (code) return { kind: 'codemm', code };
  const errno = (e as NodeJS.ErrnoException).code;
  return {
    kind: fromCore(e) ? 'core' : e instanceof SafeError ? 'desktop' : 'internal',
    name: /^\w{1,40}$/.test(e.name) ? e.name : undefined,
    code: typeof errno === 'string' && /^[A-Z0-9_]{1,40}$/.test(errno) ? errno : undefined,
  };
}
