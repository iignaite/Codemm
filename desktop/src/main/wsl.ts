// WSL 2, which Docker Desktop runs on in Windows (DESIGN §6.1): what this PC lacks, and WSL's own setup for it.
// Read with Windows' own tools by absolute path, as argument arrays. The setup runs as administrator, through
// Windows' permission prompt, and only when the learner clicked for it.
import { win32 } from 'node:path';
import type { DesktopDeps } from './dockerDesktop';
import { POWERSHELL, RESTART } from './windows';

export type WslDeps = Pick<DesktopDeps, 'platform' | 'programFiles' | 'run' | 'exists'>;

/**
 * `ready`; `missing`: no WSL, or Windows' Virtual Machine Platform is off (WSL's setup turns it on); `old`: older than
 * Docker needs; `virtualization`: off in this PC's firmware; `restart`: set up, Windows needs a restart.
 */
export type WslState = 'ready' | 'missing' | 'old' | 'virtualization' | 'restart';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
/**
 * Where WSL 2.0 and later installs. Windows' own wsl.exe is there without it, and run then it can offer to install
 * WSL at a keypress, so it runs only once this is.
 */
const PACKAGE = 'WSL\\wsl.exe';
/** Docker Desktop's minimum WSL (its Windows install page). */
const MIN = [2, 1, 5];
/**
 * Firmware virtualization, a running hypervisor, and the Virtual Machine Platform's InstallState (1 on, 2 off, 3 absent).
 * A running hypervisor makes the firmware flag read false, so both are read; Windows' own security features run one
 * without the Virtual Machine Platform, so that's read too. Multi-socket PCs list each processor.
 */
export const MACHINE =
  '$p = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue)[0].VirtualizationFirmwareEnabled; ' +
  '$h = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).HypervisorPresent; ' +
  '$v = (Get-CimInstance Win32_OptionalFeature -Filter "Name=\'VirtualMachinePlatform\'" -ErrorAction SilentlyContinue).InstallState; "$p|$h|$v"';
/**
 * A program as administrator, in its own window: Windows asks the learner first. The program and its arguments
 * arrive as $env:CODEMM_FILE and $env:CODEMM_ARGS, and its own exit code comes back. A learner who says no ends it
 * with DECLINED. .NET's Process.Start keeps Windows' error as the inner exception, which Start-Process drops, and the
 * wait is for the program alone, not every process it leaves running.
 */
export const ELEVATED =
  '$i = New-Object Diagnostics.ProcessStartInfo $env:CODEMM_FILE, "$env:CODEMM_ARGS"; $i.Verb = \'runas\'; $i.UseShellExecute = $true; ' +
  'try { $p = [Diagnostics.Process]::Start($i) } catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; exit 1 }; ' +
  'if (-not $p) { exit 1 }; $p.WaitForExit(); exit $p.ExitCode';
/** ERROR_CANCELLED: the learner said no to Windows' permission prompt. */
const DECLINED = 1223;

/** WSL's own version, the first number `wsl --version` prints, whatever its language; UTF-16 read as UTF-8 too. */
export function versionOf(output: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output.replace(/\0/g, ''));
  return m ? m.slice(1).map(Number) : undefined;
}

interface Machine {
  firmware?: boolean;
  hypervisor?: boolean;
  /** The Virtual Machine Platform is on. */
  vmp?: boolean;
}

/** MACHINE's answer; what it couldn't read is left out. */
export function machineOf(output: string): Machine {
  const [, p, h, v] = /^(\w*)\|(\w*)\|(\w*)\s*$/m.exec(output) ?? [];
  const flag = (s?: string) => (s === 'True' ? true : s === 'False' ? false : undefined);
  const vmp = v === '1' ? true : v === '2' || v === '3' ? false : undefined;
  const read: Machine = { firmware: flag(p), hypervisor: flag(h), vmp };
  return Object.fromEntries(Object.entries(read).filter(([, x]) => x !== undefined));
}

const older = (v: number[], min: number[]) => {
  const i = v.findIndex((n, k) => n !== min[k]);
  return i >= 0 && v[i] < min[i];
};

export function wsl(d: WslDeps) {
  let machine: Promise<Machine> | undefined;
  let restart = false;

  /**
   * Read once, by every check at once: none of it changes while Windows runs. An answer that failed is read again next
   * time; one that timed out isn't, so a stuck PowerShell holds up one check only.
   */
  const readMachine = () =>
    (machine ??= d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', MACHINE], { timeoutMs: 15_000 }).then((r) => {
      if (r.code !== 0 && r.code !== null) machine = undefined;
      return machineOf(r.output);
    }));

  /**
   * What WSL needs on this PC, or nothing when that can't be read (Docker's own messages speak then). The Virtual
   * Machine Platform comes before WSL's version: WSL's setup turns it on, and its update doesn't.
   */
  async function state(): Promise<WslState | undefined> {
    if (d.platform !== 'win32') return undefined;
    if (restart) return 'restart';
    const m = await readMachine();
    if (m.firmware === false && m.hypervisor === false) return 'virtualization';
    if (!d.exists(win32.join(d.programFiles ?? 'C:\\Program Files', PACKAGE))) return 'missing';
    // Where the feature can't be read, no hypervisor running says the Virtual Machine Platform isn't on.
    if (m.vmp === false || (m.vmp === undefined && m.hypervisor === false)) return 'missing';
    const r = await d.run(WSL, ['--version'], { env: { WSL_UTF8: '1' }, timeoutMs: 20_000 });
    const version = r.code === 0 ? versionOf(r.output) : undefined;
    if (!version) return undefined;
    return older(version, MIN) ? 'old' : 'ready';
  }

  return {
    state,
    /**
     * WSL's own setup when it's missing or old, as administrator: `wsl --install --no-distribution` installs WSL and
     * turns on the Virtual Machine Platform, and `wsl --update` updates it. `asking` is told just before Windows asks
     * the learner. `done` when nothing more is needed.
     */
    async setUp(asking?: () => void): Promise<'done' | 'restart' | 'declined' | 'failed'> {
      const now = await state();
      if (now === 'restart') return 'restart';
      if (now !== 'missing' && now !== 'old') return 'done';
      const args = now === 'old' ? '--update' : '--install --no-distribution';
      asking?.();
      const r = await d.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ELEVATED], { env: { CODEMM_FILE: WSL, CODEMM_ARGS: args }, timeoutMs: 60 * 60_000 });
      if (r.code === DECLINED) return 'declined';
      if (r.code !== null && RESTART.has(r.code)) restart = true;
      else if (r.code !== 0) return 'failed';
      // A Virtual Machine Platform setup turns on runs only after a restart: none is needed only when it was on and
      // running already, so WSL itself was all that was missing.
      else if (now === 'missing') {
        const m = await readMachine();
        restart = !(m.vmp === true && m.hypervisor === true);
      }
      return restart ? 'restart' : 'done';
    },
  };
}
