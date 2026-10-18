// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computerCheck, waitWhileStarting, type Probe } from './computer';
import type { Computer } from '../shared/api';

function probe(over: Partial<Probe> = {}): Probe & { clock: number } {
  const p: Probe & { clock: number } = {
    clock: 0,
    find: () => ({ path: '/usr/local/bin/docker', js: false }),
    info: async () => ({ exit: 0, output: '27.3.1|linux\n' }),
    sandbox: async () => true,
    now: (): number => p.clock,
    ...over,
  };
  return p;
}

const states = async (check: () => Promise<{ checks: { state: string; detail?: string }[] }>) => (await check()).checks.map((c) => (c.detail ? `${c.state}:${c.detail}` : c.state));

describe('check this computer (§6.1, D13)', () => {
  it('passes when Docker is found, answers with Linux containers, and the sandbox works', async () => {
    expect(await computerCheck(probe(), 'darwin')()).toEqual({
      platform: 'mac',
      ready: true,
      checks: [{ id: 'docker-installed', state: 'ok' }, { id: 'docker-running', state: 'ok' }, { id: 'sandbox', state: 'ok' }],
    });
  });

  it('missing Docker fails the first row, and nothing after it runs', async () => {
    let asked = false;
    const check = computerCheck(probe({ find: () => null, info: async () => ((asked = true), { exit: 0, output: '' }) }), 'win32');
    expect(await states(check)).toEqual(['problem', 'waiting', 'waiting']);
    expect(asked).toBe(false);
  });

  it("calls a silent Docker stopped, not starting, unless Codemm just opened it (§6.1)", async () => {
    const p = probe({ info: async () => ({ exit: 1, output: 'Cannot connect to the Docker daemon' }) });
    expect(await states(computerCheck(p, 'darwin'))).toEqual(['ok', 'problem', 'waiting']);
  });

  it('says Docker is starting for 3 minutes after Codemm opened or installed it, then asks to open it', async () => {
    const p = probe({ info: async () => ({ exit: 1, output: 'Cannot connect to the Docker daemon' }), startedAt: () => 0 });
    const check = computerCheck(p, 'darwin');
    expect(await states(check)).toEqual(['ok', 'problem:starting', 'waiting']);
    p.clock = 3 * 60_000 + 1;
    expect(await states(check)).toEqual(['ok', 'problem', 'waiting']);
  });

  it('offers to install Docker on macOS and Windows, and reports the install', async () => {
    const install = { phase: 'downloading' as const, progress: 0.4 };
    const mac = await computerCheck(probe({ find: () => null, canInstall: true, install: () => install }), 'darwin')();
    expect(mac.canInstall).toBe(true);
    expect(mac.install).toEqual(install);
    const linux = await computerCheck(probe({ find: () => null }), 'linux')();
    expect(linux.canInstall).toBeUndefined();
    expect(linux.install).toBeUndefined();
  });

  it('asks to switch from Windows containers', async () => {
    expect(await states(computerCheck(probe({ info: async () => ({ exit: 0, output: '27.3.1|windows' }) }), 'win32'))).toEqual(['ok', 'problem:windows-containers', 'waiting']);
  });

  it('runs the sandbox check once it passes, not on every re-check', async () => {
    let runs = 0;
    const check = computerCheck(probe({ sandbox: async () => (runs++, true) }), 'darwin');
    await check();
    await check();
    expect(runs).toBe(1);
    expect(await states(computerCheck(probe({ sandbox: async () => false }), 'darwin'))).toEqual(['ok', 'ok', 'problem']);
  });

  it('waits while Docker is starting, and only then (§6.1)', async () => {
    const running = (detail?: 'starting'): Computer => ({ platform: 'mac', ready: !detail, checks: [{ id: 'docker-running', state: detail ? 'problem' : 'ok', ...(detail ? { detail } : {}) }] });
    const answers = [running('starting'), running('starting'), running()];
    let naps = 0;
    await waitWhileStarting(async () => answers.shift()!, async () => void naps++);
    expect(naps).toBe(2);
    naps = 0;
    const stopped: Computer = { platform: 'mac', ready: false, checks: [{ id: 'docker-running', state: 'problem' }] };
    await waitWhileStarting(async () => stopped, async () => void naps++);
    expect(naps).toBe(0);
  });
});
