// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_AGENT, SIGNED_OUT } from '../shared/api';
import { connector, type Lookup } from './connect';
import { desktopState } from './state';

function lookup(over: Partial<Lookup> = {}): Lookup {
  return {
    find: (bin) => (bin === 'cursor-agent' ? null : { path: `/bin/${bin}`, js: false }),
    signedIn: async () => true,
    version: async (id) => ({ claude: '2.1.283', codex: '0.157.0', cursor: null })[id],
    ...over,
  };
}

const state = () => desktopState(mkdtempSync(join(tmpdir(), 'codemm-connect-')));

describe('connect (§3.1, §3.3)', () => {
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
    const cursor = agents.find((a) => a.id === 'cursor')!;
    expect([cursor.models, cursor.model]).toEqual([[], null]);
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
    await expect(c.chooseModel('cursor', 'sonnet')).rejects.toThrow();
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
});
