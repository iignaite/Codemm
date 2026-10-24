// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nodeDesktopDeps } from './dockerDesktop';
import { fetchGet } from './download';
import { ELEVATED, machineOf, versionOf, wsl, type WslDeps } from './wsl';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const PACKAGE = 'C:\\Program Files\\WSL\\wsl.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** `wsl --version` as WSL prints it with WSL_UTF8=1. */
const VERSION = (v: string) => `WSL version: ${v}\r\nKernel version: 6.6.87.2-1\r\nWSLg version: 1.0.66\r\nWindows version: 10.0.26100.4652\r\n`;

type Call = { file: string; args: string[]; env?: Record<string, string> };

function fake(over: { version?: { code: number | null; output: string }; machine?: string; elevated?: number; installed?: boolean; platform?: NodeJS.Platform } = {}) {
  const calls: Call[] = [];
  let installed = over.installed ?? true;
  let version = over.version ?? { code: 0, output: VERSION('2.6.1.0') };
  let machine = over.machine ?? 'True|True';
  const deps: WslDeps = {
    platform: over.platform ?? 'win32',
    programFiles: 'C:\\Program Files',
    exists: (p) => p === PACKAGE && installed,
    run: async (file, args, opts) => {
      calls.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
      if (file === WSL) return version;
      if (args[3] === ELEVATED) {
        // WSL's own setup: it installs the package and turns on Windows' Virtual Machine Platform.
        if (over.elevated === 0) [installed, version] = [true, { code: 0, output: VERSION('2.6.1.0') }];
        return { code: over.elevated ?? 0, output: '' };
      }
      if (file === POWERSHELL) return { code: 0, output: `${machine}\r\n` };
      return { code: 0, output: '' };
    },
  };
  return { w: wsl(deps), calls, set: (m: string) => (machine = m) };
}

const commands = (calls: Call[]) => calls.map((c) => [c.file, ...c.args].join(' '));

describe('WSL for Docker Desktop on Windows (§6.1)', () => {
  it('reads the version WSL prints, in UTF-8 or the UTF-16 an older wsl.exe still writes, in any language', () => {
    expect(versionOf(VERSION('2.6.1.0'))).toEqual([2, 6, 1]);
    expect(versionOf('WSL-Version: 2.1.5.0\r\nKernelversion: 5.15.146.1-2\r\n')).toEqual([2, 1, 5]);
    expect(versionOf(Buffer.from(VERSION('2.0.14.0'), 'utf16le').toString())).toEqual([2, 0, 14]);
    expect(versionOf('')).toBeUndefined();
    expect(versionOf('Invalid command line option: --version\r\n')).toBeUndefined();
  });

  it("reads whether this PC's firmware allows virtualization and whether a hypervisor runs", () => {
    expect(machineOf('True|True\r\n')).toEqual({ firmware: true, hypervisor: true });
    // A running hypervisor hides the firmware flag: it reads false then.
    expect(machineOf('False|True\r\n')).toEqual({ firmware: false, hypervisor: true });
    expect(machineOf('False|False\r\n')).toEqual({ firmware: false, hypervisor: false });
    expect(machineOf('|\r\n')).toEqual({});
    expect(machineOf('Get-CimInstance : Access denied\r\n')).toEqual({});
  });

  it('is ready with WSL 2.1.5 or later and a running hypervisor, asking only by absolute path and argument array', async () => {
    const f = fake();
    expect(await f.w.state()).toBe('ready');
    expect(commands(f.calls)).toEqual([
      expect.stringMatching(/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile -NonInteractive -Command /),
      `${WSL} --version`,
    ]);
    // wsl.exe writes UTF-16 unless told otherwise.
    expect(f.calls[1].env).toEqual({ WSL_UTF8: '1' });
    expect(f.calls[0].args[3]).toContain('VirtualizationFirmwareEnabled');
    expect(f.calls[0].args[3]).toContain('HypervisorPresent');
  });

  it("never runs Windows' own wsl.exe while WSL isn't installed: it can offer to install it there and then", async () => {
    const f = fake({ installed: false });
    expect(await f.w.state()).toBe('missing');
    expect(commands(f.calls).some((c) => c.startsWith(WSL))).toBe(false);
  });

  it('needs an update below 2.1.5, and setup when no hypervisor runs yet', async () => {
    expect(await fake({ version: { code: 0, output: VERSION('2.1.4.0') } }).w.state()).toBe('old');
    expect(await fake({ version: { code: 0, output: VERSION('2.1.5.0') } }).w.state()).toBe('ready');
    // WSL is there but Windows' Virtual Machine Platform isn't on: WSL's own setup turns it on.
    expect(await fake({ machine: 'True|False' }).w.state()).toBe('missing');
  });

  it('says to turn on virtualization when the firmware has it off and no hypervisor runs', async () => {
    expect(await fake({ machine: 'False|False' }).w.state()).toBe('virtualization');
    expect(await fake({ machine: 'False|True' }).w.state()).toBe('ready');
  });

  it("claims nothing it couldn't read", async () => {
    expect(await fake({ machine: '' }).w.state()).toBe('ready');
    expect(await fake({ version: { code: null, output: '' } }).w.state()).toBeUndefined();
    expect(await fake({ version: { code: 0, output: 'garbled' } }).w.state()).toBeUndefined();
    expect(await fake({ platform: 'darwin' }).w.state()).toBeUndefined();
  });

  it("reads the machine once: neither the firmware nor the hypervisor changes while Windows runs", async () => {
    const f = fake();
    await f.w.state();
    f.set('False|False');
    expect(await f.w.state()).toBe('ready');
    expect(commands(f.calls).filter((c) => c.startsWith(POWERSHELL))).toHaveLength(1);
  });

  it("sets WSL up as administrator, through Windows' permission prompt, then needs a restart", async () => {
    const f = fake({ installed: false, machine: 'True|False', elevated: 0 });
    expect(await f.w.setUp()).toBe('restart');
    const elevate = f.calls.find((c) => c.args[3] === ELEVATED)!;
    expect(elevate.file).toBe(POWERSHELL);
    // What runs reaches PowerShell as environment variables, never inside the command text.
    expect(elevate.env).toEqual({ CODEMM_FILE: WSL, CODEMM_ARGS: '--install --no-distribution' });
    expect(ELEVATED).toContain("$i.Verb = 'runas'");
    expect(ELEVATED).toContain('$p.WaitForExit(); exit $p.ExitCode');
    expect(ELEVATED).not.toContain('Start-Process');
    // Until Windows restarts, that's what's left.
    expect(await f.w.state()).toBe('restart');
  });

  it('updates an old WSL, and needs no restart when the hypervisor already runs', async () => {
    const f = fake({ version: { code: 0, output: VERSION('2.0.14.0') }, elevated: 0 });
    expect(await f.w.setUp()).toBe('done');
    expect(f.calls.find((c) => c.args[3] === ELEVATED)!.env).toEqual({ CODEMM_FILE: WSL, CODEMM_ARGS: '--update' });
    expect(await f.w.state()).toBe('ready');
  });

  it('says when the learner said no, when the setup failed, and when Windows asks for a restart', async () => {
    expect(await fake({ installed: false, elevated: 1223 }).w.setUp()).toBe('declined');
    expect(await fake({ installed: false, elevated: 1 }).w.setUp()).toBe('failed');
    const restart = fake({ installed: false, elevated: 3010 });
    expect(await restart.w.setUp()).toBe('restart');
    expect(await restart.w.state()).toBe('restart');
  });

  it('runs nothing elevated when WSL needs nothing, or what it needs is the firmware', async () => {
    for (const f of [fake(), fake({ machine: 'False|False' })]) {
      expect(await f.w.setUp()).toBe('done');
      expect(f.calls.some((c) => c.args[3] === ELEVATED)).toBe(false);
    }
  });
});

// These run the real commands on the computer the tests run on: CI's Windows machine.
describe('on this computer, for real', () => {
  const real = nodeDesktopDeps({ get: fetchGet, arch: process.arch });

  it.runIf(process.platform === 'win32')("reads this PC's WSL and virtualization without hanging", { timeout: 60_000 }, async () => {
    const calls: string[] = [];
    const state = await wsl({ ...real, run: (file, args, opts) => (calls.push([file, ...args].join(' ')), real.run(file, args, opts)) }).state();
    // GitHub's runners are virtual machines: what they hold varies, so this records it rather than expecting it.
    console.log('wsl state', state, calls, real.exists(PACKAGE));
    expect([undefined, 'ready', 'missing', 'old', 'virtualization']).toContain(state);
    const machine = await real.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '$p = @(Get-CimInstance Win32_Processor)[0].VirtualizationFirmwareEnabled; $h = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent; "$p|$h"']);
    console.log('machine', machine);
  });

  it.runIf(process.platform === 'win32')('starts a program as administrator and hands back its own exit code', { timeout: 60_000 }, async (ctx) => {
    // Only where Windows elevates without asking (CI): a permission prompt would wait for a click.
    const uac = await real.run('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System']);
    if (!/^\s*(EnableLUA|ConsentPromptBehaviorAdmin)\s+REG_DWORD\s+0x0\s*$/m.test(uac.output)) ctx.skip();
    // Robocopy given one folder and no destination is a usage error, exit code 16: the code comes back unchanged.
    const r = await real.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ELEVATED], { env: { CODEMM_FILE: 'C:\\Windows\\System32\\Robocopy.exe', CODEMM_ARGS: 'install' }, timeoutMs: 45_000 });
    expect(r).toMatchObject({ code: 16 });
  });
});
