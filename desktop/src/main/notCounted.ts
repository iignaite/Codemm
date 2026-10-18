// An infrastructure failure during Try it, Check, Run or a lesson example isn't counted (DESIGN §5): the learner
// sees why, and nothing is recorded.
import { NOT_COUNTED, REBUILD } from '../shared/api';
import { infraOf, kindOf } from './core/failures';
import type { Log } from './log';

/** Why an error means the run wasn't counted, or null for any other error. */
export function notCounted(error: unknown): string | null {
  if (kindOf(error) === 'image-missing') return REBUILD;
  const kind = infraOf(error);
  return kind ? NOT_COUNTED[kind] : null;
}

/**
 * For a catch: a failure this computer caused becomes `{ kind, reason }` and is logged, and anything else is
 * rethrown as it was. Synchronous, so a caller's own try/catch keeps its timing.
 */
export function asNotCounted<K extends 'not-counted' | 'not-run'>(error: unknown, log: Log, run: 'program' | 'example' | 'try' | 'check', kind: K): { kind: K; reason: string } {
  const reason = notCounted(error);
  if (!reason) throw error;
  log('not-counted', { run, reason });
  return { kind, reason };
}
