// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nodeDesktopDeps } from './dockerDesktop';
import { fetchGet } from './download';
import { ELEVATED, MACHINE, machineOf, versionOf, wsl, type WslDeps } from './wsl';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const PACKAGE = 'C:\\Program Files\\WSL\\wsl.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** `wsl --version` as WSL prints it with WSL_UTF8=1. */
const VERSION = (v: string) => `WSL version: ${v}\r\nKernel version: 6.6.87.2-1\r\nWSLg version: 1.0.66\r\nWindows version: 10.0.26100.4652\r\n`;

type Call = { file: string; args: string[]; env?: Record<string, string> };

function fake(
  over: { version?: { code: number | null; output: string }; machine?: string; machineCode?: number | null; elevated?: number; installed?: boolean; platform?: NodeJS.Platform } = {},
) {
  const calls: Call[] = [];
  let installed = over.installed ?? true;
  let version = over.version ?? { code: 0, output: VERSION('2.6.1.0') };
  let machine = over.machine ?? 'True|True|1';
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
      if (file === POWERSHELL) return { code: over.machineCode === undefined ? 0 : over.machineCode, output: `${machine}\r\n` };
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

  it("reads whether this PC's firmware allows virtualization, whether a hypervisor runs, and whether the Virtual Machine Platform is on", () => {
    expect(machineOf('True|True|1\r\n')).toEqual({ firmware: true, hypervisor: true, vmp: true });
    // A running hypervisor hides the firmware flag: it reads false then.
    expect(machineOf('False|True|1\r\n')).toEqual({ firmware: false, hypervisor: true, vmp: true });
    expect(machineOf('False|False|2\r\n')).toEqual({ firmware: false, hypervisor: false, vmp: false });
    expect(machineOf('True|False|3\r\n')).toEqual({ firmware: true, hypervisor: false, vmp: false });
    // A feature it isn't allowed to read prints nothing there; whatever else PowerShell printed is skipped.
    expect(machineOf('Get-CimInstance : Access denied\r\nTrue|True|\r\n')).toEqual({ firmware: true, hypervisor: true });
    expect(machineOf('||\r\n')).toEqual({});
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
    expect(f.calls[0].args[3]).toBe(MACHINE);
    expect(MACHINE).toContain('VirtualizationFirmwareEnabled');
    expect(MACHINE).toContain('HypervisorPresent');
    expect(MACHINE).toContain("Name='VirtualMachinePlatform'");
  });

  it("never runs Windows' own wsl.exe while WSL isn't installed: it can offer to install it there and then", async () => {
    const f = fake({ installed: false });
    expect(await f.w.state()).toBe('missing');
    expect(commands(f.calls).some((c) => c.startsWith(WSL))).toBe(false);
  });

  it("needs an update below 2.1.5, and setup when Windows' Virtual Machine Platform is off", async () => {
    expect(await fake({ version: { code: 0, output: VERSION('2.1.4.0') } }).w.state()).toBe('old');
    expect(await fake({ version: { code: 0, output: VERSION('2.1.5.0') } }).w.state()).toBe('ready');
    expect(await fake({ version: { code: 0, output: VERSION('3.0.3.0') } }).w.state()).toBe('ready');
    // WSL is there but the Virtual Machine Platform isn't on, even with Windows' own security running a hypervisor:
    // WSL's own setup turns it on.
    expect(await fake({ machine: 'True|True|2' }).w.state()).toBe('missing');
    expect(await fake({ machine: 'True|False|2' }).w.state()).toBe('missing');
    // Where the feature can't be read, no running hypervisor says the same.
    expect(await fake({ machine: 'True|False|' }).w.state()).toBe('missing');
    // On but not running: a restart Codemm didn't ask for, or a hypervisor turned off. Codemm claims nothing.
    expect(await fake({ machine: 'True|False|1' }).w.state()).toBe('ready');
    // Setup comes before an update: the update doesn't turn the Virtual Machine Platform on.
    expect(await fake({ machine: 'True|False|2', version: { code: 0, output: VERSION('2.0.14.0') } }).w.state()).toBe('missing');
  });

  it('says to turn on virtualization when the firmware has it off and no hypervisor runs', async () => {
    expect(await fake({ machine: 'False|False|1' }).w.state()).toBe('virtualization');
    expect(await fake({ machine: 'False|True|1' }).w.state()).toBe('ready');
  });

  it("claims nothing it couldn't read", async () => {
    expect(await fake({ machine: '' }).w.state()).toBe('ready');
    expect(await fake({ version: { code: null, output: '' } }).w.state()).toBeUndefined();
    expect(await fake({ version: { code: 0, output: 'garbled' } }).w.state()).toBeUndefined();
    expect(await fake({ platform: 'darwin' }).w.state()).toBeUndefined();
  });

  it("reads the machine once, even for checks at once: none of it changes while Windows runs", async () => {
    const f = fake();
    await Promise.all([f.w.state(), f.w.state()]);
    f.set('False|False|2');
    expect(await f.w.state()).toBe('ready');
    expect(commands(f.calls).filter((c) => c.startsWith(POWERSHELL))).toHaveLength(1);
  });

  it('reads the machine again after an answer that failed, within 15 seconds each time', async () => {
    const f = fake({ machineCode: 1, machine: '' });
    await f.w.state();
    await f.w.state();
    const reads = f.calls.filter((c) => c.file === POWERSHELL);
    expect(reads).toHaveLength(2);
    // A timed-out read isn't repeated: one stuck PowerShell holds up one check.
    const stuck = fake({ machineCode: null, machine: '' });
    await stuck.w.state();
    await stuck.w.state();
    expect(stuck.calls.filter((c) => c.file === POWERSHELL)).toHaveLength(1);
  });

  it("sets WSL up as administrator, through Windows' permission prompt, then needs a restart", async () => {
    const f = fake({ installed: false, machine: 'True|False|2', elevated: 0 });
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

  it('needs a restart after setup unless the Virtual Machine Platform was on and running, even with a hypervisor already there', async () => {
    // Windows' own security runs a hypervisor without the Virtual Machine Platform.
    expect(await fake({ installed: false, machine: 'True|True|2', elevated: 0 }).w.setUp()).toBe('restart');
    expect(await fake({ installed: false, machine: 'True|True|', elevated: 0 }).w.setUp()).toBe('restart');
    // Only WSL itself was missing.
    const f = fake({ installed: false, machine: 'True|True|1', elevated: 0 });
    expect(await f.w.setUp()).toBe('done');
    expect(await f.w.state()).toBe('ready');
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
    for (const f of [fake(), fake({ machine: 'False|False|1' })]) {
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
    const machine = await real.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', MACHINE]);
    console.log('wsl state', state, calls, real.exists(PACKAGE), machine);
    expect([undefined, 'ready', 'missing', 'old', 'virtualization']).toContain(state);
    expect(machine.code).toBe(0);
  });

  it.runIf(process.platform === 'win32')('starts a program as administrator and hands back its own exit code', { timeout: 60_000 }, async (ctx) => {
    // Only where Windows elevates without asking (CI): a permission prompt would wait for a click.
    const uac = await real.run('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System']);
    if (!/^\s*(EnableLUA|ConsentPromptBehaviorAdmin)\s+REG_DWORD\s+0x0\s*$/m.test(uac.output)) ctx.skip();
    // Robocopy given folders that aren't there is an error, exit code 16: the code comes back unchanged, with two words
    // in the arguments as WSL's setup has.
    const r = await real.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ELEVATED], { env: { CODEMM_FILE: 'C:\\Windows\\System32\\Robocopy.exe', CODEMM_ARGS: '--install --no-distribution' }, timeoutMs: 45_000 });
    expect(r).toMatchObject({ code: 16 });
  });
});
