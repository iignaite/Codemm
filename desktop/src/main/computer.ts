// "Check this computer" (DESIGN §6.1): Docker is installed, it's running with
// Linux containers, and the sandbox works. Only the first failing row is a
// problem; the ones after it wait. Where Codemm installs Docker Desktop, a
// docker command alone, with no engine answering, isn't installed yet. On
// Windows, an engine that doesn't answer says what WSL needs, when that's why.
import type { CheckId, Computer, ComputerCheck, DockerInstall, Platform } from '../shared/api';
import type { Executable } from './agent/bridge';
import { STARTING_MS } from './dockerDesktop';
import { noLog, type Log } from './log';
import type { WslState } from './wsl';

export interface Probe {
  find(): Executable | null;
  /** Whether the found engine is there, running, and running Linux containers (core sandbox.ts runtimeStateOf). */
  state(docker: Executable): Promise<'missing' | 'down' | 'windows' | 'ready'>;
  /** Core doctor's network-isolation check, with why it failed and, when known, the cause on this computer. */
  sandbox(): Promise<{ ok: boolean; detail: string; kind?: 'offline' | 'disk' | 'docker' }>;
  now(): number;
  /** When Codemm last opened or installed Docker Desktop. Only then is a silent Docker "starting". */
  startedAt?(): number | undefined;
  /** Codemm can install Docker Desktop here, and the install it started. */
  canInstall?: boolean;
  /** Docker Desktop's own app is here (a docker command can come without it). */
  desktopInstalled?(): boolean;
  /** Docker Desktop's app is running, whether or not its engine answers yet. */
  desktopRunning?(): Promise<boolean>;
  install?(): DockerInstall | undefined;
  /** On Windows, what WSL needs for Docker Desktop's engine, when that can be read (wsl.ts). */
  wsl?(): Promise<WslState | undefined>;
}

/** What WSL needs, as the running row says it: nothing when it's ready. */
const WSL_DETAIL = { missing: 'wsl-missing', old: 'wsl-old', virtualization: 'virtualization', restart: 'restart' } as const;


export const platformOf = (p: NodeJS.Platform): Platform => (p === 'darwin' ? 'mac' : p === 'win32' ? 'windows' : 'linux');

/**
 * A re-checkable check: it remembers a sandbox that passed. A Docker that doesn't answer is "starting" only for
 * 3 minutes after Codemm opened or installed it, or after this check first saw Docker Desktop's app running (the
 * learner opened it); otherwise it's stopped, and the fix is to open it (§6.1). What WSL needs comes before either:
 * Docker's engine can't start without it.
 * A sandbox that fails within 3 minutes of Docker coming up is still being checked; after that, the fix is a restart.
 */
export function computerCheck(probe: Probe, platform: NodeJS.Platform = process.platform, log: Log = noLog): () => Promise<Computer> {
  let sandboxOk = false;
  let reason: ComputerCheck['reason'];
  let down = false;
  let upAt: number | undefined;
  /** When this check first saw Docker Desktop's app running with its engine down. */
  let openAt: number | undefined;
  let lastReason: string | undefined;
  const recent = (at: number | undefined) => at !== undefined && probe.now() - at <= STARTING_MS;

  async function failing(): Promise<{ at: number; detail?: ComputerCheck['detail']; reason?: ComputerCheck['reason'] } | null> {
    const docker = probe.find();
    const state = docker ? await probe.state(docker) : 'missing';
    if (state === 'missing' || state === 'down') down = true;
    // Open Docker Desktop can't start an engine that isn't Docker Desktop's: install it instead.
    if (state === 'missing' || (state === 'down' && probe.canInstall && probe.desktopInstalled?.() === false)) return { at: 0 };
    if (state !== 'down') openAt = undefined;
    else if (await probe.desktopRunning?.()) openAt ??= probe.now();
    else openAt = undefined;
    if (state === 'down') {
      // Docker's installer or WSL's setup asked for a restart: nothing starts before it.
      if (probe.install?.()?.problem === 'restart') return { at: 1, detail: 'restart' };
      const wsl = await probe.wsl?.();
      if (wsl && wsl !== 'ready') return { at: 1, detail: WSL_DETAIL[wsl] };
      return { at: 1, ...(recent(probe.startedAt?.()) || recent(openAt) ? { detail: 'starting' as const } : {}) };
    }
    if (state === 'windows') return { at: 1, detail: 'windows-containers' };
    if (down) [down, upAt] = [false, probe.now()];
    if (!sandboxOk) {
      const sandbox = await probe.sandbox();
      sandboxOk = sandbox.ok;
      // Logged when the reason changes, not on every re-check.
      if (!sandbox.ok && sandbox.detail !== lastReason) log('sandbox', { reason: sandbox.detail, ...(sandbox.kind ? { kind: sandbox.kind } : {}) });
      lastReason = sandbox.ok ? undefined : sandbox.detail;
      const text = sandbox.detail.replace(/^inconclusive: /, '');
      reason = !sandbox.ok && sandbox.kind ? { kind: sandbox.kind, text, ...(text !== sandbox.detail ? { inconclusive: true as const } : {}) } : undefined;
    }
    if (sandboxOk) return null;
    // Offline or out of disk is no slow first container; anything else just after Docker came up is still being checked.
    if (reason && reason.kind !== 'docker') return { at: 2, reason };
    if (recent(upAt) || recent(probe.startedAt?.())) return { at: 2, detail: 'checking' };
    return { at: 2, ...(reason ? { reason } : {}) };
  }

  return async () => {
    const problem = await failing();
    const ids: CheckId[] = ['docker-installed', 'docker-running', 'sandbox'];
    const checks = ids.map((id, i): ComputerCheck => {
      if (!problem || i < problem.at) return { id, state: 'ok' };
      if (i > problem.at) return { id, state: 'waiting' };
      return { id, state: 'problem', ...(problem.detail ? { detail: problem.detail } : {}), ...(problem.reason ? { reason: problem.reason } : {}) };
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
