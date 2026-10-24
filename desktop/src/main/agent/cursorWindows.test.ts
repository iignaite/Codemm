// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorEntry, cursorExecutable } from './cursorWindows';
import { tempDir } from '../testing/temp';

/** A Cursor install root (%LOCALAPPDATA%\cursor-agent) with these version folders; `false` leaves out node.exe. */
function install(versions: Record<string, boolean>) {
  const root = tempDir('codemm-cursor-');
  writeFileSync(join(root, 'cursor-agent.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*\r\n');
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
    const { root, entry } = install({ '2026.06.12-f6aba9a': true, '2026.06.12-19-59-36-0123abc': true, '2026.06.12-9-59-36-fffffff': true });
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

  it('fails closed: no usable version, or no versions folder, is not installed', () => {
    expect(cursorEntry(install({ '2026.10.22-27dcf5f': false, '2026.10.23-1234567.new': true }).root)).toBeNull();
    expect(cursorEntry(tempDir('codemm-cursor-'))).toBeNull();
    expect(cursorEntry(join(tempDir('codemm-cursor-'), 'gone'))).toBeNull();
  });

  it('a node.exe beside the launcher runs there, as the launcher does', () => {
    const { root } = install({ '2026.10.22-27dcf5f': true });
    writeFileSync(join(root, 'node.exe'), 'MZ');
    writeFileSync(join(root, 'index.js'), '');
    expect(cursorEntry(root)).toEqual({ node: join(root, 'node.exe'), script: join(root, 'index.js') });
  });

  it("an Executable that runs Cursor's node.exe on its index.js, with the launcher's environment", () => {
    const { root, entry } = install({ '2026.10.22-27dcf5f': true });
    const { node, script } = entry('2026.10.22-27dcf5f');
    const local = join('C:', 'Users', 'Ann Lee', 'AppData', 'Local');
    expect(cursorExecutable(root, { LOCALAPPDATA: local })).toEqual({
      path: node,
      js: false,
      args: [script],
      env: { CURSOR_INVOKED_AS: 'cursor-agent.cmd', NODE_COMPILE_CACHE: join(local, 'cursor-compile-cache') },
    });
    // The launcher keeps a compile cache the learner set.
    expect(cursorExecutable(root, { LOCALAPPDATA: local, NODE_COMPILE_CACHE: 'D:\\cache' })?.env).toEqual({ CURSOR_INVOKED_AS: 'cursor-agent.cmd' });
    expect(cursorExecutable(tempDir('codemm-cursor-'), {})).toBeNull();
  });
});
