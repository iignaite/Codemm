// An infrastructure failure during Try it, Check, Run or a lesson example isn't counted (DESIGN §5): the learner
// sees why, and nothing is recorded.
import { NOT_COUNTED, REBUILD } from '../shared/api';
import { infraOf, kindOf } from './core/failures';
import { SafeError } from './errors';
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

/** What to do about each of this computer's problems after a rebuild that stopped. */
const TRY_AGAIN = {
  docker: 'Open Docker Desktop, then try again.',
  disk: 'Free up disk space, then try again.',
  offline: 'Connect to the internet, then try again.',
} as const;
export const NOT_ACCEPTED = "The rebuilt environment wasn't accepted, so nothing changed.";

/**
 * A failed rebuild as the learner may read it. Core's messages carry commands, image names and Docker's output, so
 * this computer's problem becomes Codemm's own words and its next step, and a rebuild core didn't accept (a gate
 * failed, or the results changed) says only that nothing changed: it builds under a candidate tag and keeps the
 * installed image until every check passes (core §4.4). Any other error goes on as it was.
 */
export function rebuildFailure(error: unknown): unknown {
  const kind = infraOf(error);
  if (kind) return new SafeError(`${NOT_COUNTED[kind]} ${TRY_AGAIN[kind]}`);
  return error instanceof Error && error.name === 'CodemmError' && !kindOf(error) ? new SafeError(NOT_ACCEPTED) : error;
}
