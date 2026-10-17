// Core's infrastructure failures, by their messages (src/sandbox.ts, src/judge.ts,
// src/store.ts). They are this computer's problems: nothing is recorded, no
// agent retry is spent, and the learner can fix them (DESIGN §5, §6.1).
export type Infra = 'disk' | 'offline' | 'docker';

export function infra(message: string): Infra | null {
  if (/not enough disk space|ran out of disk space|no space left on device/i.test(message)) return 'disk';
  if (/couldn't reach the network|could not resolve host|network is unreachable/i.test(message)) return 'offline';
  if (/container runtime|Windows containers|Cannot connect to the Docker daemon/i.test(message)) return 'docker';
  return null;
}
