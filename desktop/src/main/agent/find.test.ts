// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerFolders, find, shimTarget, type Where } from './find';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'codemm-find-'));
  const at = (...p: string[]) => join(root, ...p);
  return { root, at };
}

const posix = (path: string, home: string): Where => ({ platform: 'darwin', path, home });

describe('find (§3.1)', () => {
  it('finds a native executable on PATH', () => {
    const { at } = tree();
    mkdirSync(at('bin'));
    writeFileSync(at('bin', 'claude'), '\x7fELF binary');
    chmodSync(at('bin', 'claude'), 0o755);
    expect(find('claude', posix(at('bin'), at('home')))).toEqual({ path: at('bin', 'claude'), js: false });
  });

  it('runs a Node launcher as a script, through its symlink', () => {
    const { at } = tree();
    mkdirSync(at('lib'), { recursive: true });
    mkdirSync(at('bin'));
    writeFileSync(at('lib', 'codex.js'), '#!/usr/bin/env node\nconsole.log(1)\n');
    symlinkSync(at('lib', 'codex.js'), at('bin', 'codex'));
    const found = find('codex', posix(at('bin'), at('home')));
    expect(found?.js).toBe(true);
    expect(found?.path.endsWith('codex.js')).toBe(true);
  });

  it('looks in the usual folders when PATH has nothing (GUI apps load no shell profile)', () => {
    const { at } = tree();
    mkdirSync(at('home', '.local', 'bin'), { recursive: true });
    writeFileSync(at('home', '.local', 'bin', 'claude'), 'binary');
    expect(find('claude', posix('', at('home')))).toEqual({ path: at('home', '.local', 'bin', 'claude'), js: false });
    expect(find('nothing-here', posix('', at('home')))).toBeNull();
  });

  it("reads an npm .cmd shim's script instead of running the shim", () => {
    const { at } = tree();
    mkdirSync(at('npm', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(at('npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '#!/usr/bin/env node\n');
    writeFileSync(
      at('npm', 'codex.cmd'),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    expect(shimTarget(at('npm', 'codex.cmd'))?.replace(/\\/g, '/')).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
  });

  it("gives Docker's calls the folders its credential helpers live in, as well as the one it was found in", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codemm-docker-')));
    const cellar = join(dir, 'Cellar', 'docker', 'bin');
    const desktop = join(dir, 'Docker.app', 'Contents', 'Resources', 'bin');
    mkdirSync(cellar, { recursive: true });
    mkdirSync(desktop, { recursive: true });
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(cellar, 'docker'), '');
    symlinkSync(join(cellar, 'docker'), join(dir, 'bin', 'docker'));
    // Homebrew's Docker CLI, beside Docker Desktop: the helpers are only in Docker Desktop's folder.
    expect(dockerFolders(join(dir, 'bin', 'docker'), [desktop])).toEqual([join(dir, 'bin'), cellar, desktop]);
    expect(dockerFolders(join(cellar, 'docker'), [join(dir, 'missing')])).toEqual([cellar]);
  });
});
