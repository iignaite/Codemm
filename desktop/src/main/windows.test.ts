// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nodeDesktopDeps } from './dockerDesktop';
import { fetchGet } from './download';
import { ELEVATED, restartWindows } from './windows';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe("Windows' own tools (§6.1)", () => {
  it("restarts Windows only when asked, with Windows' own shutdown, no forced close and no console", async () => {
    const calls: string[] = [];
    const run = async (file: string, args: string[]) => (calls.push([file, ...args].join(' ')), { code: 0, output: '' });
    await restartWindows({ platform: 'win32', run });
    expect(calls).toEqual(['C:\\Windows\\System32\\shutdown.exe /r /t 0']);
    // A restart a policy blocks says so.
    await expect(restartWindows({ platform: 'win32', run: async () => ({ code: 5, output: 'Access is denied.' }) })).rejects.toThrow("Windows didn't restart.");
    calls.length = 0;
    await restartWindows({ platform: 'darwin', run });
    expect(calls).toEqual([]);
  });

  it("runs as administrator through .NET, keeping Windows' code for the learner's no, and nothing outside its own text", () => {
    expect(ELEVATED).toContain("$i.Verb = 'runas'");
    expect(ELEVATED).toContain('$p.WaitForExit(); exit $p.ExitCode');
    expect(ELEVATED).toContain('-eq 1223) { exit 1223 }');
    expect(ELEVATED).not.toContain('Start-Process');
  });
});

// These run the real commands on the computer the tests run on: CI's Windows machine.
describe('on this computer, for real', () => {
  const real = nodeDesktopDeps({ get: fetchGet, arch: process.arch });

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
