// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorEntry, cursorExecutable, systemCa } from './cursorWindows';
import { tempDir } from '../testing/temp';

/** A Cursor install root (%LOCALAPPDATA%\cursor-agent) with these version folders; `false` leaves out node.exe. */
function install(versions: Record<string, boolean>, ps1?: string) {
  const root = tempDir('codemm-cursor-');
  writeFileSync(join(root, 'cursor-agent.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*\r\n');
  if (ps1 !== undefined) writeFileSync(join(root, 'cursor-agent.ps1'), ps1);
  for (const [name, complete] of Object.entries(versions)) {
    mkdirSync(join(root, 'versions', name), { recursive: true });
    writeFileSync(join(root, 'versions', name, 'index.js'), '');
    if (complete) writeFileSync(join(root, 'versions', name, 'node.exe'), 'MZ');
  }
  return { root, entry: (v: string) => ({ node: join(root, 'versions', v, 'node.exe'), script: join(root, 'versions', v, 'index.js') }) };
}

describe("Cursor's own Node and script on Windows (§3.1)", () => {
  it('one version: its node.exe and index.js', () => {
    const { root, entry } = install({ '2026.10.22-27dcf5f': true });
    expect(cursorEntry(root)).toEqual(entry('2026.10.22-27dcf5f'));
  });

  it('several versions: the newest, compared as numbers, not as text', () => {
    const { root, entry } = install({ '2026.9.30-aaaaaaa': true, '2026.10.2-bbbbbbb': true, '2026.10.16-e3cb207': true, '2025.12.31-ccccccc': true });
    expect(cursorEntry(root)).toEqual(entry('2026.10.16-e3cb207'));
  });

  it('a timestamped version folder counts, newest by its time on the same day', () => {
    const { root, entry } = install({ '2026.06.12-f6aba9a': true, '2026.06.12-19-59-36-0123abc': true });
    expect(cursorEntry(root)).toEqual(entry('2026.06.12-19-59-36-0123abc'));
  });

  it('skips staged, previous and temporary folders', () => {
    const { root, entry } = install({ '2026.10.16-e3cb207': true, '2026.10.22-27dcf5f.new': true, '2026.10.22-27dcf5f.previous': true, '.tmp-2026.10.23-1234567': true, 'extract-1b2c': true });
    expect(cursorEntry(root)).toEqual(entry('2026.10.16-e3cb207'));
  });

  it('skips a version missing node.exe or index.js', () => {
    const { root, entry } = install({ '2026.10.16-e3cb207': true, '2026.10.22-27dcf5f': false });
    expect(cursorEntry(root)).toEqual(entry('2026.10.16-e3cb207'));
  });

  it('takes the version the launcher script names, when that folder is there', () => {
    const { root, entry } = install({ '2026.10.16-e3cb207': true, '2026.10.22-27dcf5f': true }, '$version = "2026.10.16-e3cb207"\r\n& "$PSScriptRoot\\versions\\$version\\node.exe" ...\r\n');
    expect(cursorEntry(root)).toEqual(entry('2026.10.16-e3cb207'));
  });

  it("falls back to the newest when the launcher script names a folder that isn't there, or only a pattern", () => {
    const missing = install({ '2026.10.16-e3cb207': true, '2026.10.22-27dcf5f': true }, '$version = "2026.10.30-9999999"\r\n');
    expect(cursorEntry(missing.root)).toEqual(missing.entry('2026.10.22-27dcf5f'));
    const pattern = install({ '2026.10.16-e3cb207': true, '2026.10.22-27dcf5f': true }, "Where-Object { $_.Name -match '^\\d{4}\\.\\d{1,2}\\.\\d{1,2}-[a-f0-9]+$' }\r\n");
    expect(cursorEntry(pattern.root)).toEqual(pattern.entry('2026.10.22-27dcf5f'));
  });

  it('fails closed: no usable version, or no versions folder, is not installed', () => {
    expect(cursorEntry(install({ '2026.10.22-27dcf5f': false, '2026.10.23-1234567.new': true }).root)).toBeNull();
    expect(cursorEntry(tempDir('codemm-cursor-'))).toBeNull();
    expect(cursorEntry(join(tempDir('codemm-cursor-'), 'gone'))).toBeNull();
  });

  it("an Executable that runs Cursor's node.exe on its index.js, with --use-system-ca where that Node takes it", () => {
    const { root, entry } = install({ '2026.10.22-27dcf5f': true });
    const { node, script } = entry('2026.10.22-27dcf5f');
    expect(cursorExecutable(root, () => true)).toEqual({ path: node, js: false, args: ['--use-system-ca', script], env: { CURSOR_INVOKED_AS: 'cursor-agent' } });
    expect(cursorExecutable(root, () => false)).toEqual({ path: node, js: false, args: [script], env: { CURSOR_INVOKED_AS: 'cursor-agent' } });
    expect(cursorExecutable(tempDir('codemm-cursor-'), () => true)).toBeNull();
  });

  it('asks each Node about --use-system-ca once, as an argument array, and skips it for the file credential store', () => {
    const calls: [string, string[]][] = [];
    const probe = (file: string, args: string[]) => (calls.push([file, args]), file.endsWith('new.exe'));
    const node = join(tempDir('codemm-cursor-'), 'new.exe');
    expect(systemCa(node, {}, probe)).toBe(true);
    expect(systemCa(node, {}, probe)).toBe(true);
    expect(calls).toEqual([[node, ['--use-system-ca', '--version']]]);
    // Cursor's own launcher leaves the flag off when AGENT_CLI_CREDENTIAL_STORE=file.
    expect(systemCa(node, { AGENT_CLI_CREDENTIAL_STORE: 'file' }, probe)).toBe(false);
    const old = join(tempDir('codemm-cursor-'), 'old.exe');
    expect(systemCa(old, {}, probe)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('the real probe answers for a real Node', () => {
    expect(typeof systemCa(process.execPath)).toBe('boolean');
    expect(systemCa(join(tempDir('codemm-cursor-'), 'no-node.exe'))).toBe(false);
  });
});
