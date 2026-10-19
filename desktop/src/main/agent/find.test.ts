// @vitest-environment node
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerFolders, find, folders, here, shimTarget, withDockerFolders, type Where } from './find';
import { tempDir } from '../testing/temp';

function tree() {
  const root = tempDir('codemm-find-');
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

  it('looks where Volta, nvm and fnm put the CLIs they install, nvm\'s default version first', () => {
    const put = (at: (...p: string[]) => string, ...p: string[]) => {
      mkdirSync(at(...p.slice(0, -1)), { recursive: true });
      writeFileSync(at(...p), 'binary');
      return at(...p);
    };
    const volta = tree();
    put(volta.at, 'home', '.volta', 'bin', 'claude');
    expect(find('claude', posix('', volta.at('home')))?.path).toBe(volta.at('home', '.volta', 'bin', 'claude'));

    const nvm = tree();
    put(nvm.at, 'home', '.nvm', 'versions', 'node', 'v20.11.0', 'bin', 'codex');
    put(nvm.at, 'home', '.nvm', 'versions', 'node', 'v9.0.0', 'bin', 'codex');
    // With no default alias, the newest version.
    expect(find('codex', posix('', nvm.at('home')))?.path).toBe(nvm.at('home', '.nvm', 'versions', 'node', 'v20.11.0', 'bin', 'codex'));
    mkdirSync(nvm.at('home', '.nvm', 'alias'));
    writeFileSync(nvm.at('home', '.nvm', 'alias', 'default'), '9\n');
    expect(find('codex', posix('', nvm.at('home')))?.path).toBe(nvm.at('home', '.nvm', 'versions', 'node', 'v9.0.0', 'bin', 'codex'));

    const fnm = tree();
    put(fnm.at, 'home', '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'codex');
    expect(find('codex', posix('', fnm.at('home')))?.path).toBe(fnm.at('home', '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'codex'));
  });

  it("finds Codex where OpenAI's Windows installer puts it, and Claude Code in the profile's .local\\bin", () => {
    const { at } = tree();
    mkdirSync(at('local', 'Programs', 'OpenAI', 'Codex', 'bin'), { recursive: true });
    writeFileSync(at('local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'MZ');
    mkdirSync(at('home', '.local', 'bin'), { recursive: true });
    writeFileSync(at('home', '.local', 'bin', 'claude.exe'), 'MZ');
    const w: Where = { platform: 'win32', path: '', home: at('home'), localAppData: at('local') };
    expect(find('codex', w)?.path).toBe(join(at('local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    expect(find('claude', w)?.path).toBe(join(at('home'), '.local', 'bin', 'claude.exe'));
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

  it("finds Docker where OrbStack, Rancher Desktop and Docker Desktop's own install link it (a GUI app's PATH has none of them)", () => {
    for (const where of [['.orbstack', 'bin'], ['.rd', 'bin'], ['.docker', 'bin']]) {
      const { at } = tree();
      mkdirSync(at('home', ...where), { recursive: true });
      // Any name will do: the folders don't depend on it, and a real `docker` on this machine would be found first.
      writeFileSync(at('home', ...where, 'codemm-fake-engine'), 'binary');
      expect(find('codemm-fake-engine', posix('/usr/bin', at('home')))).toEqual({ path: at('home', ...where, 'codemm-fake-engine'), js: false });
    }
  });

  it("also looks in Podman's installer folder, and Homebrew's, where Colima's Docker client lives", () => {
    const usual = folders(posix('', '/Users/someone'));
    // Home folders are joined with this machine's separator, as find does.
    expect(usual).toEqual(expect.arrayContaining(['/opt/podman/bin', '/opt/homebrew/bin', '/usr/local/bin', join('/Users/someone', '.orbstack', 'bin'), join('/Users/someone', '.rd', 'bin')]));
    // Windows keeps its own list.
    expect(folders({ platform: 'win32', path: '', home: 'C:\\Users\\someone' })).not.toContain('/opt/podman/bin');
  });

  it("gives Docker's calls the folders its credential helpers live in, as well as the one it was found in", () => {
    const dir = realpathSync(tempDir('codemm-docker-'));
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

  it("adds Docker's folders to a PATH once, keeping what was there", () => {
    const dir = realpathSync(tempDir('codemm-path-'));
    writeFileSync(join(dir, 'docker'), '');
    const path = ['/usr/bin', '/bin'].join(delimiter);
    const once = withDockerFolders(path, join(dir, 'docker'), []);
    expect(once).toBe([path, dir].join(delimiter));
    expect(withDockerFolders(once, join(dir, 'docker'), [])).toBe(once);
  });

  it('searches only the given folders when a test sets them: the journey\'s "no Docker" run', () => {
    const dir = realpathSync(tempDir('codemm-only-'));
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\n');
    chmodSync(join(dir, 'docker'), 0o755);
    const w: Where = { platform: 'darwin', path: '', home: '/nowhere', searchDirs: [] };
    expect(find('docker', w)).toBeNull();
    expect(find('docker', { ...w, searchDirs: [dir] })).toEqual({ path: join(dir, 'docker'), js: false });
    expect(here({ CODEMM_TEST_SEARCH_DIRS: [dir, '/also'].join(delimiter) }).searchDirs).toEqual([dir, '/also']);
    expect(here({}).searchDirs).toBeUndefined();
  });
});
