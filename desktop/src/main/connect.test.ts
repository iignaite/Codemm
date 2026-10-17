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
    expect(agents.find((a) => a.id === 'codex')?.recommended).toBe('gpt-5.6-luna');
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
