// "Check this computer" (DESIGN §6.1): Docker is installed, it's running with
// Linux containers, and the sandbox works. Only the first failing row is a
// problem; the ones after it wait.
import type { CheckId, Computer, ComputerCheck, DockerInstall, Platform } from '../shared/api';
import type { Executable } from './agent/bridge';
import { STARTING_MS } from './dockerDesktop';

export interface Probe {
  find(): Executable | null;
  /** core sandbox.ts runtimeState: whether the engine is there, running, and running Linux containers. */
  state(): Promise<'missing' | 'down' | 'windows' | 'ready'>;
  /** Core doctor's network-isolation check. */
  sandbox(): Promise<boolean>;
  now(): number;
  /** When Codemm last opened or installed Docker Desktop. Only then is a silent Docker "starting". */
  startedAt?(): number | undefined;
  /** Codemm can install Docker Desktop here, and the install it started. */
  canInstall?: boolean;
  install?(): DockerInstall | undefined;
}


export const platformOf = (p: NodeJS.Platform): Platform => (p === 'darwin' ? 'mac' : p === 'win32' ? 'windows' : 'linux');

/**
 * A re-checkable check: it remembers a sandbox that passed. A Docker that doesn't answer is "starting" only for
 * 3 minutes after Codemm opened or installed it; otherwise it's stopped, and the fix is to open it (§6.1).
 */
export function computerCheck(probe: Probe, platform: NodeJS.Platform = process.platform): () => Promise<Computer> {
  let sandboxOk = false;

  async function failing(): Promise<{ at: number; detail?: ComputerCheck['detail'] } | null> {
    if (!probe.find()) return { at: 0 };
    const state = await probe.state();
    if (state === 'missing') return { at: 0 };
    if (state === 'down') {
      const started = probe.startedAt?.();
      return { at: 1, ...(started !== undefined && probe.now() - started <= STARTING_MS ? { detail: 'starting' as const } : {}) };
    }
    if (state === 'windows') return { at: 1, detail: 'windows-containers' };
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
    const install = probe.install?.();
    return { platform: platformOf(platform), checks, ready: !problem, ...(probe.canInstall ? { canInstall: true } : {}), ...(install ? { install } : {}) };
  };
}

/**
 * Waits while Docker is starting, which is only after Codemm opened or installed it: setup and checks started
 * then wait for the daemon, within the same 3-minute window Check this computer shows. A stopped Docker fails fast (§6.1).
 */
export async function waitWhileStarting(computer: () => Promise<Computer>, nap: () => Promise<void>): Promise<void> {
  while ((await computer()).checks.some((c) => c.id === 'docker-running' && c.detail === 'starting')) await nap();
}
