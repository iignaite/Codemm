// Core's infrastructure failures, by their messages (src/sandbox.ts, src/judge.ts,
// src/store.ts). They are this computer's problems: nothing is recorded, no
// agent retry is spent, and the learner can fix them (DESIGN §5, §6.1).
export type Infra = 'disk' | 'offline' | 'docker';

export function infra(message: string): Infra | null {
  if (/not enough disk space|ran out of disk space|no space left on device/i.test(message)) return 'disk';
  if (/couldn't reach the network|could not resolve host|network is unreachable/i.test(message)) return 'offline';
  // A build that can't run Docker's credential helper is this computer's Docker problem, not the track's.
  if (/container runtime|Windows containers|Cannot connect to the Docker daemon|error getting credentials|container couldn't be removed|Couldn't list Codemm's containers|container couldn't start/i.test(message)) return 'docker';
  return null;
}

/** A failure no agent caused: this computer's problems, or a track image that needs a rebuild. A job spends no retry on it (§6.1). */
export function spendsNoRetry(message: string): boolean {
  return infra(message) !== null || /image for .* is missing or changed/i.test(message);
}
