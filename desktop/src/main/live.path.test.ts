// @vitest-environment node
// An agent or Docker installed while Codemm is open, on Windows: its installer adds a folder to the PATH in the
// registry, which a running process never sees in its own environment (§3.1).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { find, type Where } from './agent/find';
import { livePath } from './agent/livePath';
import { computerCheck } from './computer';
import { connector } from './connect';
import { desktopState } from './state';
import { live, researched } from './testing/fakes';
import { tempDir } from './testing/temp';

/** A Windows whose registry PATH an installer can change, and a clock to let a 2-second-old read go stale. */
function windows() {
  const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32', LOCALAPPDATA: tempDir('codemm-local-') };
  const registry = { machine: 'C:\\Windows\\system32', user: '' };
  let clock = 0;
  const refresh = livePath({
    platform: 'win32',
    env,
    run: async (_file, args) => `\r\n${args[1]}\r\n    Path    REG_EXPAND_SZ    ${args[1] === 'HKCU\\Environment' ? registry.user : registry.machine}\r\n`,
    now: () => clock,
  });
  // Only PATH: the usual folders are find's own tests.
  const where = (): Where => ({ platform: 'win32', path: env.PATH ?? '', home: tempDir('codemm-home-'), searchDirs: [] });
  return { env, registry, refresh, where, later: () => (clock += 2_001) };
}

describe('found once installed, with no restart (§3.1)', () => {
  it('Connect shows an agent installed while Codemm was open on the next look', async () => {
    const w = windows();
    const connect = connector({ find: (bin) => find(bin, w.where()), signedIn: async () => true, version: async () => '2.1.283' }, desktopState(tempDir('codemm-state-')));
    const { api } = live({}, { connect, livePath: w.refresh });
    expect((await api.agents()).find((a) => a.id === 'claude')!.state).toBe('missing');

    const dir = join(w.env.LOCALAPPDATA!, 'Agent', 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.exe'), 'MZ');
    // The installer adds its folder to the user PATH, as %LOCALAPPDATA%\…, which Windows expands.
    w.registry.user = `%LocalAppData%${dir.slice(w.env.LOCALAPPDATA!.length)}`;
    w.later();
    expect((await api.agents()).find((a) => a.id === 'claude')!.state).toBe('not-connected');
    expect((await api.connect('claude')).state).toBe('connected');
  });

  it('Check this computer finds Docker installed while Codemm was open on the next check', async () => {
    const w = windows();
    const computer = computerCheck({ find: () => find('docker', w.where()), state: async () => 'ready', sandbox: async () => ({ ok: true, detail: 'blocked' }), now: () => 0 }, 'win32');
    const { api } = live({}, { computer, livePath: w.refresh });
    expect((await api.computer()).ready).toBe(false);

    const dir = join(w.env.LOCALAPPDATA!, 'Programs', 'DockerDesktop', 'resources', 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'docker.exe'), 'MZ');
    w.registry.user = dir;
    w.later();
    expect((await api.computer()).ready).toBe(true);
  });

  it('a job starts on the PATH as it is now, which the agent and its Codemm server inherit', async () => {
    const order: string[] = [];
    // Done only a moment later: a job that didn't wait for it would start first.
    const refresh = () => new Promise<void>((resolve) => setTimeout(() => (order.push('fresh'), resolve()), 5));
    const t = live({ research: (_job, usual) => (order.push('job'), usual()) }, { livePath: refresh });
    await researched(t);
    // Connect brings it up to date, and so does the job, just before it starts.
    expect(order).toEqual(['fresh', 'fresh', 'job']);
  });
});
