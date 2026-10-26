// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computerCheck, waitWhileStarting, type Probe } from './computer';
import type { Fields } from './log';
import type { Computer } from '../shared/api';

const PASS = { ok: true, detail: 'blocked' };
const FAIL = { ok: false, detail: 'inconclusive: the comparison container failed (no route)' };

function probe(over: Partial<Probe> = {}): Probe & { clock: number } {
  const p: Probe & { clock: number } = {
    clock: 0,
    find: () => ({ path: '/usr/local/bin/docker', js: false }),
    state: async () => 'ready',
    sandbox: async () => PASS,
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

  describe('without Docker, the WASI engine (core §4.5)', () => {
    it('says practice can run here when no Docker is installed but wasmtime runs', async () => {
      const missing = await computerCheck(probe({ find: () => null, wasi: async () => true }), 'win32')();
      expect(missing).toMatchObject({ ready: false, wasi: true });
      expect(missing.checks.map((c) => c.state)).toEqual(['problem', 'waiting', 'waiting']);
    });

    it("doesn't when Docker is installed, running or not: then the agent writes Docker tracks, and the fix is to start it", async () => {
      let asked = false;
      const wasi = async () => ((asked = true), true);
      expect(await computerCheck(probe({ state: async () => 'down', wasi }), 'darwin')()).not.toHaveProperty('wasi');
      // A docker command without Docker Desktop's app, its engine down: installed, though the row offers Install Docker.
      expect(await computerCheck(probe({ state: async () => 'down', canInstall: true, desktopInstalled: () => false, wasi }), 'darwin')()).not.toHaveProperty('wasi');
      expect(await computerCheck(probe({ sandbox: async () => FAIL, wasi }), 'darwin')()).not.toHaveProperty('wasi');
      expect(asked).toBe(false);
    });

    it("doesn't ask when Docker is ready: its flows are unchanged", async () => {
      let asked = false;
      const ready = await computerCheck(probe({ wasi: async () => ((asked = true), true) }), 'darwin')();
      expect(ready).not.toHaveProperty('wasi');
      expect(asked).toBe(false);
    });

    it("says nothing of it when wasmtime doesn't run, and asks again on the next check", async () => {
      let asks = 0;
      const check = computerCheck(probe({ find: () => null, wasi: async () => (asks++, false) }), 'darwin');
      expect(await check()).not.toHaveProperty('wasi');
      await check();
      expect(asks).toBe(2);
    });

    it('asks once wasmtime has run: it stays there while Codemm runs', async () => {
      let asks = 0;
      const check = computerCheck(probe({ find: () => null, wasi: async () => (asks++, true) }), 'darwin');
      await check();
      expect(await check()).toMatchObject({ wasi: true });
      expect(asks).toBe(1);
    });
  });

  it('missing Docker fails the first row, and nothing after it runs', async () => {
    let asked = false;
    const check = computerCheck(probe({ find: () => null, state: async () => ((asked = true), 'ready') }), 'win32');
    expect(await states(check)).toEqual(['problem', 'waiting', 'waiting']);
    expect(asked).toBe(false);
  });

  it("calls a silent Docker stopped, not starting, unless Codemm just opened it (§6.1)", async () => {
    const p = probe({ state: async () => 'down' });
    expect(await states(computerCheck(p, 'darwin'))).toEqual(['ok', 'problem', 'waiting']);
  });

  it('says Docker is starting for 3 minutes after Codemm opened or installed it, then asks to open it', async () => {
    const p = probe({ state: async () => 'down', startedAt: () => 0 });
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

  it('says Docker is starting for 3 minutes after it first sees Docker Desktop running with its engine down, as when the learner opened it', async () => {
    let running = true;
    const p = probe({ state: async () => 'down', desktopRunning: async () => running });
    const check = computerCheck(p, 'darwin');
    p.clock = 60_000;
    expect(await states(check)).toEqual(['ok', 'problem:starting', 'waiting']);
    p.clock = 60_000 + 3 * 60_000 + 1;
    // Still down after that: Docker Desktop is open, but its engine is stopped.
    expect(await states(check)).toEqual(['ok', 'problem', 'waiting']);
    running = false;
    expect(await states(check)).toEqual(['ok', 'problem', 'waiting']);
    // Opened again later: a new 3 minutes.
    running = true;
    expect(await states(check)).toEqual(['ok', 'problem:starting', 'waiting']);
  });

  it('offers to install Docker Desktop for a docker command without it, when no engine answers (§6.1)', async () => {
    // Homebrew's docker, or a stopped Colima or OrbStack: Open Docker Desktop would fail.
    const bare = probe({ state: async () => 'down', canInstall: true, desktopInstalled: () => false });
    expect(await states(computerCheck(bare, 'darwin'))).toEqual(['problem', 'waiting', 'waiting']);
    // With Docker Desktop there, Docker is stopped; and an engine that answers is all Codemm needs.
    expect(await states(computerCheck(probe({ state: async () => 'down', canInstall: true, desktopInstalled: () => true }), 'win32'))).toEqual(['ok', 'problem', 'waiting']);
    expect(await states(computerCheck(probe({ canInstall: true, desktopInstalled: () => false }), 'darwin'))).toEqual(['ok', 'ok', 'ok']);
    // Where Codemm can't install it (Linux), a stopped engine is just stopped.
    expect(await states(computerCheck(probe({ state: async () => 'down', desktopInstalled: () => false }), 'linux'))).toEqual(['ok', 'problem', 'waiting']);
  });

  it("says what WSL needs instead of starting or Open Docker Desktop, while Docker's engine is down (§6.1)", async () => {
    for (const [wsl, detail] of [['missing', 'wsl-missing'], ['old', 'wsl-old'], ['virtualization', 'virtualization'], ['restart', 'restart']] as const) {
      const p = probe({ state: async () => 'down', startedAt: () => 0, wsl: async () => wsl });
      expect(await states(computerCheck(p, 'win32'))).toEqual(['ok', `problem:${detail}`, 'waiting']);
    }
    // WSL is fine, or can't be read: Docker is starting, as before.
    for (const wsl of ['ready', undefined] as const) {
      const p = probe({ state: async () => 'down', startedAt: () => 0, wsl: async () => wsl });
      expect(await states(computerCheck(p, 'win32'))).toEqual(['ok', 'problem:starting', 'waiting']);
    }
  });

  it("asks for Windows' restart on the running row when Docker's installer needed one", async () => {
    const p = probe({ state: async () => 'down', install: () => ({ phase: 'failed', problem: 'restart' }), wsl: async () => 'ready' });
    expect(await states(computerCheck(p, 'win32'))).toEqual(['ok', 'problem:restart', 'waiting']);
  });

  it('asks nothing of WSL while Docker answers, or before Docker is installed', async () => {
    let asked = 0;
    const wsl = async () => (asked++, 'missing' as const);
    expect(await states(computerCheck(probe({ wsl }), 'win32'))).toEqual(['ok', 'ok', 'ok']);
    expect(await states(computerCheck(probe({ find: () => null, wsl }), 'win32'))).toEqual(['problem', 'waiting', 'waiting']);
    expect(asked).toBe(0);
  });

  it('asks to switch from Windows containers', async () => {
    expect(await states(computerCheck(probe({ state: async () => 'windows' }), 'win32'))).toEqual(['ok', 'problem:windows-containers', 'waiting']);
  });

  it('runs the sandbox check once it passes, not on every re-check', async () => {
    let runs = 0;
    const check = computerCheck(probe({ sandbox: async () => (runs++, PASS) }), 'darwin');
    await check();
    await check();
    expect(runs).toBe(1);
    expect(await states(computerCheck(probe({ sandbox: async () => FAIL }), 'darwin'))).toEqual(['ok', 'ok', 'problem']);
  });

  it('is still checking the sandbox for 3 minutes after Docker comes up, then asks to restart it', async () => {
    let state: 'down' | 'ready' = 'down';
    const p = probe({ state: async () => state, sandbox: async () => FAIL });
    const check = computerCheck(p, 'darwin');
    expect(await states(check)).toEqual(['ok', 'problem', 'waiting']);
    state = 'ready';
    p.clock = 10_000;
    expect(await states(check)).toEqual(['ok', 'ok', 'problem:checking']);
    p.clock = 10_000 + 3 * 60_000 + 1;
    expect(await states(check)).toEqual(['ok', 'ok', 'problem']);
  });

  it('is still checking the sandbox just after Codemm opened or installed Docker', async () => {
    expect(await states(computerCheck(probe({ startedAt: () => 0, sandbox: async () => FAIL }), 'darwin'))).toEqual(['ok', 'ok', 'problem:checking']);
  });

  it("says what the self-test found when core knows the cause on this computer (core §4.3)", async () => {
    const offline = { ok: false, kind: 'offline' as const, detail: "Docker couldn't reach the network to download the test image (dial tcp: lookup registry-1.docker.io: no such host). Connect to the internet, check any VPN, proxy or firewall, then try again." };
    const sandboxRow = async (p: Probe) => (await computerCheck(p, 'darwin')()).checks[2];
    // Offline is offline even just after Docker started: it isn't a slow first container.
    expect(await sandboxRow(probe({ startedAt: () => 0, sandbox: async () => offline }))).toEqual({ id: 'sandbox', state: 'problem', reason: { kind: 'offline', text: offline.detail } });
    // Docker's own causes (a folder to share, its sign-in helper) say so once Docker has had its first minutes.
    const mount = { ok: false, kind: 'docker' as const, detail: "Docker couldn't start a test container with Codemm's folder mounted (mounts denied). Codemm keeps what a check mounts in /Users/me/.codemm/runs. If the engine says it can't see that folder, share it with the engine (Colima and Rancher Desktop share only your home folder by default), then try again." };
    expect(await sandboxRow(probe({ sandbox: async () => mount }))).toEqual({ id: 'sandbox', state: 'problem', reason: { kind: 'docker', text: mount.detail } });
    expect(await sandboxRow(probe({ startedAt: () => 0, sandbox: async () => mount }))).toEqual({ id: 'sandbox', state: 'problem', detail: 'checking' });
    // An inconclusive one says what it saw, and that it is a guess.
    const slow = { ok: false, kind: 'docker' as const, detail: 'inconclusive: Docker took more than 3 minutes to download the test image. Check the connection and that Docker is responding, then try again.' };
    expect(await sandboxRow(probe({ sandbox: async () => slow }))).toEqual({
      id: 'sandbox', state: 'problem', reason: { kind: 'docker', text: 'Docker took more than 3 minutes to download the test image. Check the connection and that Docker is responding, then try again.', inconclusive: true },
    });
    // With no cause known, there is nothing to say but Restart Docker.
    expect(await sandboxRow(probe({ sandbox: async () => FAIL }))).toEqual({ id: 'sandbox', state: 'problem' });
  });

  it('logs why the sandbox check failed, once per reason, and nothing when it passes', async () => {
    const logged: [string, Fields | undefined][] = [];
    const log = (event: string, fields?: Fields) => void logged.push([event, fields]);
    const failing = computerCheck(probe({ sandbox: async () => FAIL }), 'darwin', log);
    await failing();
    await failing();
    await computerCheck(probe(), 'darwin', log)();
    expect(logged).toEqual([['sandbox', { reason: FAIL.detail }]]);
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
