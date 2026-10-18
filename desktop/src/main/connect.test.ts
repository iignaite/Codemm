// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NO_AGENT, SIGNED_OUT } from '../shared/api';
import type { AgentId, AgentInstall } from '../shared/api';
import { connector, type AgentSetup, type Lookup } from './connect';
import { desktopState } from './state';
import { tempDir } from './testing/temp';

function lookup(over: Partial<Lookup> = {}): Lookup {
  return {
    find: (bin) => (bin === 'cursor-agent' ? null : { path: `/bin/${bin}`, js: false }),
    signedIn: async () => true,
    version: async (id) => ({ claude: '2.1.283', codex: '0.157.0', cursor: null })[id],
    ...over,
  };
}

const state = () => desktopState(tempDir('codemm-connect-'));

describe('connect (§3.1, §3.3)', () => {
  it('names the command that signs each agent in', async () => {
    const agents = await connector(lookup(), state()).agents();
    expect(agents.map((a) => a.signIn)).toEqual(['claude auth login', 'codex login', 'cursor-agent login']);
  });

  it('checks a signed-out agent again on the next look, and connects the one the learner tried once signed in', async () => {
    let ok = false;
    const c = connector(lookup({ signedIn: async () => ok }), state());
    expect((await c.connect('codex')).state).toBe('signed-out');
    expect((await c.agents()).find((a) => a.id === 'codex')!.state).toBe('signed-out');
    ok = true;
    const agents = await c.agents();
    expect(agents.map((a) => [a.id, a.state])).toEqual([['claude', 'not-connected'], ['codex', 'connected'], ['cursor', 'missing']]);
    expect((await c.chosen()).id).toBe('codex');
  });

  it('lists each agent: installed or not, tested version or not, recommended model and experimental', async () => {
    const agents = await connector(lookup(), state()).agents();
    expect(agents.map((a) => [a.id, a.state, a.untested, a.experimental])).toEqual([
      ['claude', 'not-connected', false, false],
      ['codex', 'not-connected', true, false],
      ['cursor', 'missing', false, true],
    ]);
    expect(agents.find((a) => a.id === 'codex')?.model).toBe('gpt-5.6-luna');
  });

  it('offers only bench-tested models per agent, the recommended one first and chosen by default', async () => {
    const agents = await connector(lookup(), state()).agents();
    const claude = agents.find((a) => a.id === 'claude')!;
    expect(claude.models).toEqual([
      { id: 'sonnet', label: 'Sonnet', recommended: true },
      { id: 'opus', label: 'Opus', recommended: false },
      { id: 'haiku', label: 'Haiku', recommended: false },
    ]);
    expect(claude.model).toBe('sonnet');
    expect(agents.find((a) => a.id === 'codex')!.models.map((m) => [m.id, m.recommended])).toEqual([
      ['gpt-5.6-luna', true],
      ['gpt-6-luna', false],
      ['gpt-6-astra', false],
    ]);
    // The free plan runs only Auto, so Auto is the one bench-tested Cursor model.
    const cursor = agents.find((a) => a.id === 'cursor')!;
    expect([cursor.models, cursor.model]).toEqual([[{ id: 'auto', label: 'Auto', recommended: true }], 'auto']);
  });

  it('remembers a model choice per agent in desktop.json, and jobs run with it', async () => {
    const s = state();
    const c = connector(lookup(), s);
    await c.connect('claude');
    expect(await c.chosen()).toMatchObject({ id: 'claude', model: 'sonnet' });
    expect(await c.chooseModel('claude', 'opus')).toMatchObject({ id: 'claude', model: 'opus' });
    expect(s.read().models).toEqual({ claude: 'opus' });
    expect(await c.chosen()).toMatchObject({ id: 'claude', model: 'opus' });
    expect((await connector(lookup(), s).agents()).find((a) => a.id === 'claude')!.model).toBe('opus');
  });

  it('refuses a model that is not on the agent\'s tested list', async () => {
    const c = connector(lookup(), state());
    await expect(c.chooseModel('claude', 'gpt-6-luna')).rejects.toThrow();
    await expect(c.chooseModel('cursor', 'composer-2.5')).rejects.toThrow();
  });

  it('falls back to the recommended model when a saved choice is no longer tested', async () => {
    const s = state();
    s.update((d) => ({ ...d, models: { claude: 'claude-3-old' } }));
    expect((await connector(lookup(), s).agents()).find((a) => a.id === 'claude')!.model).toBe('sonnet');
  });

  it('connects only after the sign-in check passes, and remembers the choice', async () => {
    const s = state();
    const c = connector(lookup({ signedIn: async (id) => id === 'codex' }), s);
    expect(await c.connect('claude')).toMatchObject({ state: 'signed-out' });
    expect(await c.connect('codex')).toMatchObject({ state: 'connected' });
    expect(s.read().agent).toBe('codex');
    expect((await c.agents()).find((a) => a.id === 'codex')?.state).toBe('connected');
  });

  it('a failed connect runs the sign-in check once, not again for the same answer', async () => {
    let checks = 0;
    const c = connector(lookup({ signedIn: async () => (checks++, false) }), state());
    expect(await c.connect('codex')).toMatchObject({ state: 'signed-out' });
    expect(checks).toBe(1);
    // The next look checks again, so signing in elsewhere shows up.
    await c.agents();
    expect(checks).toBe(2);
  });

  it('the chosen agent is ready only while it is installed and signed in', async () => {
    let signedIn = true;
    const s = state();
    const c = connector(lookup({ signedIn: async () => signedIn }), s);
    await expect(c.chosen()).rejects.toThrow(NO_AGENT);
    await c.connect('claude');
    expect(await c.chosen()).toMatchObject({ id: 'claude', exe: { path: '/bin/claude' } });
    signedIn = false;
    expect(await c.recheck('claude', { path: '/bin/claude', js: false })).toBe(false);
    await expect(c.chosen()).rejects.toThrow(SIGNED_OUT);
  });

  it('a relaunched app shows the agent chosen before as connected, after checking its sign-in', async () => {
    const s = state();
    await connector(lookup(), s).connect('claude');
    // A new launch: a fresh connector over the same desktop.json.
    const checked: string[] = [];
    const relaunched = connector(lookup({ signedIn: async (id) => (checked.push(id), true) }), s);
    expect((await relaunched.agents()).find((a) => a.id === 'claude')?.state).toBe('connected');
    expect(checked).toEqual(['claude']);
    // Signed out since: shown as such, not as "not connected".
    const signedOut = connector(lookup({ signedIn: async () => false }), s);
    expect((await signedOut.agents()).find((a) => a.id === 'claude')?.state).toBe('signed-out');
  });

  describe('installing and signing in', () => {
    function setup(installedAfter: AgentId[] = []) {
      const installs: AgentId[] = [];
      const signIns: { id: AgentId; path: string }[] = [];
      const status = new Map<AgentId, AgentInstall>();
      const s: AgentSetup = {
        canInstall: (id) => id !== 'cursor',
        install: (id) => {
          installs.push(id);
          status.set(id, { phase: 'done' });
          installedAfter.push(id);
        },
        status: (id) => status.get(id),
        signIn: async (id, exe) => void signIns.push({ id, path: exe.path }),
      };
      return { s, installs, signIns, status, installedAfter };
    }
    const found = (installed: AgentId[]) => (bin: string) => {
      const id = ({ claude: 'claude', codex: 'codex', 'cursor-agent': 'cursor' } as Record<string, AgentId>)[bin];
      return installed.includes(id) ? { path: `/home/.local/bin/${bin}`, js: false } : null;
    };

    it('offers Install for a missing agent, shows its progress, and connects it once installed and signed in', async () => {
      const t = setup();
      const st = state();
      const c = connector(lookup({ find: found(t.installedAfter) }), st, t.s);
      const before = (await c.agents()).find((a) => a.id === 'claude')!;
      expect(before).toMatchObject({ state: 'missing', canInstall: true });
      expect((await c.agents()).find((a) => a.id === 'cursor')!.canInstall).toBe(false);
      t.status.set('claude', { phase: 'downloading', progress: 0.4 });
      expect((await c.agents()).find((a) => a.id === 'claude')!.install).toEqual({ phase: 'downloading', progress: 0.4 });
      t.status.delete('claude');
      await c.install('claude');
      expect(t.installs).toEqual(['claude']);
      const after = (await c.agents()).find((a) => a.id === 'claude')!;
      expect(after).toMatchObject({ state: 'connected', install: { phase: 'done' } });
      expect(st.read().agent).toBe('claude');
    });

    it('after installing, a signed-out agent signs in with its own login, and connects when the learner comes back', async () => {
      const t = setup();
      let signedIn = false;
      const c = connector(lookup({ find: found(t.installedAfter), signedIn: async () => signedIn }), state(), t.s);
      let checks = 0;
      const counted = connector(lookup({ find: found(t.installedAfter), signedIn: async () => (checks++, signedIn) }), state(), t.s);
      await counted.install('codex');
      expect((await counted.agents()).find((a) => a.id === 'codex')!.state).toBe('signed-out');
      // Checked once when the install is first seen, not twice in the same look.
      expect(checks).toBe(1);
      await c.install('codex');
      expect((await c.agents()).find((a) => a.id === 'codex')!.state).toBe('signed-out');
      await c.signIn('codex');
      expect(t.signIns).toEqual([{ id: 'codex', path: '/home/.local/bin/codex' }]);
      signedIn = true;
      expect((await c.agents()).find((a) => a.id === 'codex')!.state).toBe('connected');
    });

    it('never runs an agent while Codemm is checking its install, or after the check rejected it', async () => {
      const t = setup(['codex']);
      const ran: string[] = [];
      const c = connector(lookup({ find: found(t.installedAfter), version: async (id) => (ran.push(`version ${id}`), '0.157.0'), signedIn: async (id) => (ran.push(`signed-in ${id}`), true) }), state(), t.s);
      for (const install of [{ phase: 'checking' }, { phase: 'failed', problem: 'unverified' }] as AgentInstall[]) {
        t.status.set('codex', install);
        expect((await c.agents()).find((a) => a.id === 'codex')).toMatchObject({ state: 'missing', install });
        expect(await c.connect('codex')).toMatchObject({ state: 'missing' });
        await c.signIn('codex');
      }
      expect([ran, t.signIns]).toEqual([[], []]);
      // Nor do jobs, even for the agent chosen before.
      await expect(c.chosen()).rejects.toThrow(NO_AGENT);
      // Any failed install leaves nothing Codemm checked: nothing of it runs, and Try again installs again.
      t.status.set('codex', { phase: 'failed', problem: 'failed' });
      expect((await c.agents()).find((a) => a.id === 'codex')!.state).toBe('missing');
      expect(ran).toEqual([]);
      await c.install('codex');
      expect(t.installs).toEqual(['codex']);
      // A failed Claude Code install ran nothing unchecked: one the learner then installs by hand is theirs.
      t.installedAfter.push('claude');
      t.status.set('claude', { phase: 'failed', problem: 'offline' });
      expect((await c.agents()).find((a) => a.id === 'claude')!.state).not.toBe('missing');
    });

    it('signing in again never marks a signed-in agent signed out', async () => {
      const t = setup();
      const c = connector(lookup(), state(), t.s);
      await c.connect('claude');
      await c.signIn('claude');
      expect((await c.chosen()).id).toBe('claude');
    });

    it('starts no sign-in for an agent that is not installed, and no install where it can\'t', async () => {
      const t = setup();
      const c = connector(lookup({ find: () => null }), state(), t.s);
      await c.signIn('claude');
      await c.install('cursor');
      expect([t.signIns, t.installs]).toEqual([[], []]);
    });
  });
});
