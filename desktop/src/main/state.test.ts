// @vitest-environment node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopState, workspaceOf } from './state';
import { tempDir } from './testing/temp';

const dir = () => tempDir('codemm-state-');

describe('desktop.json (§2)', () => {
  it('starts empty, then remembers the agent and tutor sessions', () => {
    const d = dir();
    const state = desktopState(d);
    expect(state.read()).toEqual({ format_version: 1, sessions: {} });
    state.update((s) => ({ ...s, agent: 'codex', sessions: { 'react|codex': 'thread-1' } }));
    expect(desktopState(d).read()).toEqual({ format_version: 1, agent: 'codex', sessions: { 'react|codex': 'thread-1' } });
  });

  it('keeps the workspace in ~/Codemm unless desktop.json names another folder (O5)', () => {
    expect(workspaceOf({ format_version: 1, sessions: {} }, '/Users/me')).toBe(join('/Users/me', 'Codemm'));
    expect(workspaceOf({ format_version: 1, sessions: {}, workspace: '/Volumes/School/Codemm' }, '/Users/me')).toBe('/Volumes/School/Codemm');
  });

  it('writes atomically, leaving no temp files', () => {
    const d = dir();
    desktopState(d).update((s) => ({ ...s, agent: 'claude' }));
    expect(readdirSync(d)).toEqual(['desktop.json']);
    expect(JSON.parse(readFileSync(join(d, 'desktop.json'), 'utf8')).format_version).toBe(1);
  });

  it('refuses a file from an unknown format version rather than guessing', () => {
    const d = dir();
    writeFileSync(join(d, 'desktop.json'), JSON.stringify({ format_version: 2 }));
    expect(() => desktopState(d).read()).toThrow('desktop.json');
  });
});
