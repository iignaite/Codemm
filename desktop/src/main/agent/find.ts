// Finds an agent CLI or Docker on this computer (DESIGN §3.1). GUI apps don't
// load shell profiles, so besides PATH this looks in the usual install folders.
// A `#!/usr/bin/env node` launcher, or an npm `.cmd` shim on Windows (never
// run, because that needs a shell), becomes the script or binary it would run.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Executable } from './bridge';

export interface Where {
  platform: NodeJS.Platform;
  path: string;
  home: string;
  /** %APPDATA%, %LOCALAPPDATA% and %ProgramFiles% on Windows. */
  appData?: string;
  localAppData?: string;
  programFiles?: string;
  /** Test-only: the folders searched after PATH, in place of the usual ones (CODEMM_TEST_SEARCH_DIRS). */
  searchDirs?: string[];
}

/** This computer: its platform, its PATH and its folders, split on its own separator like every PATH here. */
export function here(env: NodeJS.ProcessEnv = process.env): Where {
  // CODEMM_TEST_SEARCH_DIRS is set only by the macOS journey, to stage "no Docker" with Docker Desktop installed.
  const searchDirs = env.CODEMM_TEST_SEARCH_DIRS?.split(delimiter).filter(Boolean);
  return {
    platform: process.platform, path: env.PATH ?? '', home: homedir(), appData: env.APPDATA, localAppData: env.LOCALAPPDATA, programFiles: env.ProgramFiles,
    ...(searchDirs ? { searchDirs } : {}),
  };
}

/** The usual install folders, after PATH. */
export function folders(w: Where): string[] {
  if (w.searchDirs) return w.searchDirs;
  if (w.platform === 'win32') {
    return [
      w.appData && join(w.appData, 'npm'),
      w.localAppData && join(w.localAppData, 'Programs'),
      w.localAppData && join(w.localAppData, 'Volta', 'bin'),
      // Where OpenAI's Windows install script puts Codex.
      w.localAppData && join(w.localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      // Where Cursor's installer puts cursor-agent. Its .cmd starts PowerShell, so find() passes it over for now.
      w.localAppData && join(w.localAppData, 'cursor-agent'),
      // WinGet's command links, for the user and for the machine: Claude Code's and Codex's packages are portable.
      w.localAppData && join(w.localAppData, 'Microsoft', 'WinGet', 'Links'),
      w.programFiles && join(w.programFiles, 'WinGet', 'Links'),
      ...desktopBinsOf(w),
      join(w.home, '.local', 'bin'),
    ].filter((d): d is string => Boolean(d));
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(w.home, '.local', 'bin'),
    join(w.home, '.claude', 'local'),
    join(w.home, '.npm-global', 'bin'),
    join(w.home, '.bun', 'bin'),
    // Node version managers: npm-installed CLIs live beside their Node.
    join(w.home, '.volta', 'bin'),
    ...nvmBins(w.home),
    join(w.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    join(w.home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    // Container engines. Colima has no Docker client of its own: it uses Homebrew's, above.
    ...desktopBinsOf(w),
    join(w.home, '.docker', 'bin'), // Docker Desktop's per-user links
    join(w.home, '.orbstack', 'bin'),
    join(w.home, '.rd', 'bin'), // Rancher Desktop
    '/opt/podman/bin', // Podman's installer
  ];
}

/** nvm's Node versions: its default alias first, then the newest. */
function nvmBins(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  let versions: string[];
  try {
    versions = readdirSync(root).filter((v) => /^v\d+(\.\d+)*$/.test(v));
  } catch {
    return [];
  }
  const parts = (v: string) => v.slice(1).split('.').map(Number);
  versions.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  let alias = '';
  try {
    alias = readFileSync(join(home, '.nvm', 'alias', 'default'), 'utf8').trim().replace(/^v/, '');
  } catch {
    // no default alias: the newest version comes first
  }
  const preferred = alias ? versions.find((v) => v.slice(1) === alias || v.slice(1).startsWith(`${alias}.`)) : undefined;
  return [...(preferred ? [preferred] : []), ...versions.filter((v) => v !== preferred)].map((v) => join(root, v, 'bin'));
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A file's first `bytes` bytes as text, or '' when it can't be read. Only the start matters, and a binary can be large. */
function head(file: string, bytes: number): string {
  try {
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(file, 'r');
    try {
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** A `#!` launcher that runs Node is a script the app can run as Node. */
const isNodeScript = (file: string) => /^#!.*\bnode\b/.test(head(file, 200));

/** A Windows program starts with "MZ". npm's Claude Code holds a text placeholder there until its postinstall runs. */
const isWindowsProgram = (file: string) => head(file, 2) === 'MZ';

/**
 * What an npm `.cmd` shim runs, read from its fixed format: the quoted path just before `%*`. That's a Node script, or
 * for a package whose bin has no shebang, the file itself (Claude Code's `bin/claude.exe`).
 */
export function shimTarget(cmdFile: string): Executable | null {
  const text = readFileSync(cmdFile, 'utf8');
  const m = /"%(?:~dp0|dp0)%\\([^"]+\.((?:c|m)?js|exe))"[ \t]*%\*/i.exec(text);
  return m ? { path: resolve(dirname(cmdFile), ...m[1].split('\\')), js: m[2].toLowerCase() !== 'exe' } : null;
}

/** Looks for `bin` on PATH, then in the usual folders. */
export function find(bin: string, w: Where = here()): Executable | null {
  const dirs = [...w.path.split(delimiter).filter(Boolean), ...folders(w)];
  for (const dir of dirs) {
    if (w.platform === 'win32') {
      const exe = join(dir, `${bin}.exe`);
      if (isFile(exe)) return { path: exe, js: false };
      const cmd = join(dir, `${bin}.cmd`);
      if (isFile(cmd)) {
        const target = shimTarget(cmd);
        if (target && (target.js ? existsSync(target.path) : isWindowsProgram(target.path))) return target;
      }
      continue;
    }
    const file = join(dir, bin);
    if (!isFile(file)) continue;
    const real = realpathSync(file);
    return isNodeScript(real) ? { path: real, js: true } : { path: file, js: false };
  }
  return null;
}

/**
 * Where Docker Desktop installs, the one list of it: for all users, and for this one (macOS's ~/Applications; on
 * Windows, Docker's default since 4.83). Each install's app, and the folder of its CLI and credential helpers.
 * `join` is this computer's, as for every folder here; dockerDesktop.ts passes the target's, for its own tests.
 */
export function dockerDesktops(w: Pick<Where, 'platform' | 'programFiles' | 'localAppData'> & { home?: string }, pathJoin = join): { app: string; bin: string }[] {
  if (w.platform === 'win32') {
    const roots = [pathJoin(w.programFiles ?? 'C:\\Program Files', 'Docker', 'Docker'), ...(w.localAppData ? [pathJoin(w.localAppData, 'Programs', 'DockerDesktop')] : [])];
    return roots.map((root) => ({ app: pathJoin(root, 'Docker Desktop.exe'), bin: pathJoin(root, 'resources', 'bin') }));
  }
  if (w.platform !== 'darwin') return [];
  const apps = ['/Applications/Docker.app', ...(w.home ? [pathJoin(w.home, 'Applications', 'Docker.app')] : [])];
  return apps.map((app) => ({ app, bin: pathJoin(app, 'Contents', 'Resources', 'bin') }));
}

const desktopBinsOf = (w: Where) => dockerDesktops(w).map((d) => d.bin);

/**
 * The folders core's Docker calls need on PATH: where `docker` was found, where its link points, and
 * Docker Desktop's own folder. Docker runs credential helpers by name, and a GUI app's PATH has none of them.
 */
export function dockerFolders(docker: string, desktopBins = desktopBinsOf(here())): string[] {
  const folders = [dirname(docker)];
  try {
    folders.push(dirname(realpathSync(docker)));
  } catch {
    // a broken link: the folder it was found in is all there is
  }
  for (const bin of desktopBins) if (existsSync(bin)) folders.push(bin);
  return [...new Set(folders)];
}

/** `path`, this computer's own, with Docker's folders added once, after what was there (§3.1). */
export function withDockerFolders(path: string, docker: string, desktopBins = desktopBinsOf(here())): string {
  const folders = path.split(delimiter).filter(Boolean);
  return [...folders, ...dockerFolders(docker, desktopBins).filter((f) => !folders.includes(f))].join(delimiter);
}
