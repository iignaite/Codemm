// @vitest-environment node
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posix as posixPath, win32 } from 'node:path';
import { dockerDesktops, dockerFolders, find, folders, here, shimTarget, withDockerFolders, type Where } from './find';
import { tempDir } from '../testing/temp';

/** What every npm `.cmd` shim starts with (npm's cmd-shim). */
const NPM_HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
/** cmd-shim's body for a `#!/usr/bin/env node` target: a node.exe beside the shim if there is one, else node on PATH. */
const NPM_NODE_SHIM = (target: string) =>
  '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

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
    expect(shimTarget(at('npm', 'codex.cmd'))?.path.replace(/\\/g, '/')).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
  });

  it("finds the script in npm's real shim, past the node.exe beside it that the shim would prefer", () => {
    const { at } = tree();
    mkdirSync(at('npm', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(at('npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '#!/usr/bin/env node\n');
    writeFileSync(at('npm', 'codex.cmd'), NPM_HEAD + NPM_NODE_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'));
    const found = find('codex', { platform: 'win32', path: '', home: at('home'), appData: at('.') });
    expect(found?.js).toBe(true);
    expect(found?.path.replace(/\\/g, '/')).toMatch(/node_modules\/@openai\/codex\/bin\/codex\.js$/);
  });

  it('runs the native binary an npm shim points at: Claude Code from npm', () => {
    const { at } = tree();
    mkdirSync(at('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
    writeFileSync(at('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'MZ');
    // npm's shim for a target with no shebang (cmd-shim): it runs the file itself.
    writeFileSync(at('npm', 'claude.cmd'), `${NPM_HEAD}"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`);
    const target = shimTarget(at('npm', 'claude.cmd'));
    expect(target?.js).toBe(false);
    expect(target?.path.replace(/\\/g, '/')).toMatch(/npm\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/);
    expect(find('claude', { platform: 'win32', path: '', home: at('home'), appData: at('.') })).toEqual(target);
  });

  it("passes over npm's Claude Code while its binary is still the text placeholder its postinstall replaces", () => {
    const { at } = tree();
    mkdirSync(at('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
    writeFileSync(at('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'echo "Error: claude native binary not installed." >&2\nexit 1\n');
    writeFileSync(at('npm', 'claude.cmd'), `${NPM_HEAD}"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`);
    mkdirSync(at('home', '.local', 'bin'), { recursive: true });
    writeFileSync(at('home', '.local', 'bin', 'claude.exe'), 'MZ');
    expect(find('claude', { platform: 'win32', path: '', home: at('home'), appData: at('.') })?.path).toBe(join(at('home'), '.local', 'bin', 'claude.exe'));
  });

  it("finds what WinGet installs, through its command links, before the PATH it set is read", () => {
    const { at } = tree();
    mkdirSync(at('local', 'Microsoft', 'WinGet', 'Links'), { recursive: true });
    writeFileSync(at('local', 'Microsoft', 'WinGet', 'Links', 'claude.exe'), 'MZ');
    mkdirSync(at('pf', 'WinGet', 'Links'), { recursive: true });
    writeFileSync(at('pf', 'WinGet', 'Links', 'codex.exe'), 'MZ');
    const w: Where = { platform: 'win32', path: '', home: at('home'), localAppData: at('local'), programFiles: at('pf') };
    expect(find('claude', w)).toEqual({ path: join(at('local'), 'Microsoft', 'WinGet', 'Links', 'claude.exe'), js: false });
    expect(find('codex', w)).toEqual({ path: join(at('pf'), 'WinGet', 'Links', 'codex.exe'), js: false });
    expect(here({ ProgramFiles: 'D:\\Programs' }).programFiles).toBe('D:\\Programs');
  });

  it("looks in Cursor's own folder, but never runs the PowerShell launcher Cursor's installer puts there", () => {
    const { at } = tree();
    mkdirSync(at('local', 'cursor-agent'), { recursive: true });
    // Cursor's own launcher, as its Windows installer wrote it on GitHub's runner (2026.10.22).
    writeFileSync(
      at('local', 'cursor-agent', 'cursor-agent.cmd'),
      [
        '@echo off', 'rem cursor-agent-promote-staged', 'if exist "%~dp0versions\\promote-staged.cmd" call "%~dp0versions\\promote-staged.cmd"', 'if errorlevel 1 exit /b 1',
        '@echo off', 'setlocal enabledelayedexpansion', 'set "CURSOR_INVOKED_AS=%~nx0"', '', 'REM Get the directory of this script', 'set "SCRIPT_DIR=%~dp0"',
        'REM Remove trailing backslash', 'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"', '',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*', '',
      ].join('\r\n'),
    );
    const w: Where = { platform: 'win32', path: '', home: at('home'), localAppData: at('local') };
    expect(folders(w)).toContain(join(at('local'), 'cursor-agent'));
    expect(find('cursor-agent', w)).toBeNull();
  });

  it("finds Docker Desktop installed for one user, on Windows (Docker's default since 4.83) and in a Mac's ~/Applications", () => {
    const win = tree();
    mkdirSync(win.at('local', 'Programs', 'DockerDesktop', 'resources', 'bin'), { recursive: true });
    writeFileSync(win.at('local', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'), 'MZ');
    // Program Files of its own: a PC with Docker Desktop for all users would find that one first.
    const w: Where = { platform: 'win32', path: '', home: win.at('home'), localAppData: win.at('local'), programFiles: win.at('pf') };
    expect(find('docker', w)?.path).toBe(join(win.at('local'), 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'));

    const mac = tree();
    const bin = mac.at('home', 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codemm-fake-engine'), 'binary');
    expect(find('codemm-fake-engine', posix('/usr/bin', mac.at('home')))).toEqual({ path: join(bin, 'codemm-fake-engine'), js: false });
  });

  it("knows where Docker Desktop installs, for all users and for one: its app, and the folder of its CLI and credential helpers", () => {
    expect(dockerDesktops({ platform: 'darwin', home: '/Users/me' }, posixPath.join)).toEqual([
      { app: '/Applications/Docker.app', bin: '/Applications/Docker.app/Contents/Resources/bin' },
      { app: '/Users/me/Applications/Docker.app', bin: '/Users/me/Applications/Docker.app/Contents/Resources/bin' },
    ]);
    expect(dockerDesktops({ platform: 'win32', home: 'C:\\Users\\me', programFiles: 'D:\\Programs', localAppData: 'C:\\Users\\me\\AppData\\Local' }, win32.join)).toEqual([
      { app: 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe', bin: 'D:\\Programs\\Docker\\Docker\\resources\\bin' },
      { app: 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe', bin: 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin' },
    ]);
    expect(dockerDesktops({ platform: 'win32', home: 'C:\\Users\\me' }, win32.join)).toEqual([
      { app: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', bin: 'C:\\Program Files\\Docker\\Docker\\resources\\bin' },
    ]);
    expect(dockerDesktops({ platform: 'linux', home: '/home/me' })).toEqual([]);
  });

  it("splits a Windows PATH on Windows' own separator, whichever computer runs the search", () => {
    const { at } = tree();
    mkdirSync(at('bin'));
    writeFileSync(at('bin', 'codex.exe'), 'MZ');
    expect(find('codex', { platform: 'win32', path: `C:\\Windows\\system32;${at('bin')}`, home: at('home'), searchDirs: [] })?.path).toBe(join(at('bin'), 'codex.exe'));
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
