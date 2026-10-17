// "Check this computer" (DESIGN §6.1): Docker is installed, it's running with
// Linux containers, and the sandbox works. Only the first failing row is a
// problem; the ones after it wait.
import type { CheckId, Computer, ComputerCheck, Platform } from '../shared/api';
import type { Executable } from './agent/bridge';

export interface Probe {
  find(): Executable | null;
  /** `docker info --format '{{.ServerVersion}}|{{.OSType}}'`. */
  info(docker: Executable): Promise<{ exit: number; output: string }>;
  /** Core doctor's network-isolation check. */
  sandbox(): Promise<boolean>;
  now(): number;
}

const STARTING_MS = 3 * 60_000;

export const platformOf = (p: NodeJS.Platform): Platform => (p === 'darwin' ? 'mac' : p === 'win32' ? 'windows' : 'linux');

/** A re-checkable check: it remembers when Docker was first found not answering, and a sandbox that passed. */
export function computerCheck(probe: Probe, platform: NodeJS.Platform = process.platform): () => Promise<Computer> {
  let silentSince: number | undefined;
  let sandboxOk = false;

  async function failing(): Promise<{ at: number; detail?: ComputerCheck['detail'] } | null> {
    const docker = probe.find();
    if (!docker) return { at: 0 };
    const { exit, output } = await probe.info(docker);
    // `docker info` exits 0 even when the daemon is down: a running engine reports a version.
    const m = /^(\S+)\|(\w+)\s*$/m.exec(output);
    if (exit !== 0 || !m) {
      silentSince ??= probe.now();
      return { at: 1, ...(probe.now() - silentSince <= STARTING_MS ? { detail: 'starting' as const } : {}) };
    }
    silentSince = undefined;
    if (m[2] === 'windows') return { at: 1, detail: 'windows-containers' };
    sandboxOk ||= await probe.sandbox();
    return sandboxOk ? null : { at: 2 };
  }

  return async () => {
    const problem = await failing();
    const ids: CheckId[] = ['docker-installed', 'docker-running', 'sandbox'];
    const checks = ids.map((id, i): ComputerCheck => {
      if (!problem || i < problem.at) return { id, state: 'ok' };
      if (i > problem.at) return { id, state: 'waiting' };
      return { id, state: 'problem', ...(problem.detail ? { detail: problem.detail } : {}) };
    });
    return { platform: platformOf(platform), checks, ready: !problem };
  };
}
