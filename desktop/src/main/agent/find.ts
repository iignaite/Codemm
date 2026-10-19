// Finds an agent CLI or Docker on this computer (DESIGN §3.1). GUI apps don't
// load shell profiles, so besides PATH this looks in the usual install folders.
// A `#!/usr/bin/env node` launcher, or an npm `.cmd` shim on Windows (never
// run, because that needs a shell), becomes a Node script the app runs itself.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Executable } from './bridge';

export interface Where {
  platform: NodeJS.Platform;
  path: string;
  home: string;
  /** %APPDATA% and %LOCALAPPDATA% on Windows. */
  appData?: string;
  localAppData?: string;
  /** Test-only: the folders searched after PATH, in place of the usual ones (CODEMM_TEST_SEARCH_DIRS). */
  searchDirs?: string[];
}

export function here(env: NodeJS.ProcessEnv = process.env): Where {
  // CODEMM_TEST_SEARCH_DIRS is set only by the macOS journey, to stage "no Docker" with Docker Desktop installed.
  const searchDirs = env.CODEMM_TEST_SEARCH_DIRS?.split(delimiter).filter(Boolean);
  return { platform: process.platform, path: env.PATH ?? '', home: homedir(), appData: env.APPDATA, localAppData: env.LOCALAPPDATA, ...(searchDirs ? { searchDirs } : {}) };
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
      'C:\\Program Files\\Docker\\Docker\\resources\\bin',
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
    '/Applications/Docker.app/Contents/Resources/bin',
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

/** A `#!` launcher that runs Node is a script the app can run as Node. */
function isNodeScript(file: string): boolean {
  try {
    // Only the first line matters, and a native binary can be large.
    const head = Buffer.alloc(200);
    const fd = openSync(file, 'r');
    try {
      return /^#!.*\bnode\b/.test(head.subarray(0, readSync(fd, head, 0, 200, 0)).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The script an npm `.cmd` shim runs, read from its fixed format. */
export function shimTarget(cmdFile: string): string | null {
  const text = readFileSync(cmdFile, 'utf8');
  const m = /"%(?:~dp0|dp0)%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  return m ? resolve(dirname(cmdFile), m[1]) : null;
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
        const script = shimTarget(cmd);
        if (script && existsSync(script)) return { path: script, js: true };
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

/** Docker Desktop's own folders, where its credential helpers live. */
const DOCKER_DESKTOP_BINS = ['/Applications/Docker.app/Contents/Resources/bin', 'C:\\Program Files\\Docker\\Docker\\resources\\bin'];

/**
 * The folders core's Docker calls need on PATH: where `docker` was found, where its link points, and
 * Docker Desktop's own folder. Docker runs credential helpers by name, and a GUI app's PATH has none of them.
 */
export function dockerFolders(docker: string, desktopBins = DOCKER_DESKTOP_BINS): string[] {
  const folders = [dirname(docker)];
  try {
    folders.push(dirname(realpathSync(docker)));
  } catch {
    // a broken link: the folder it was found in is all there is
  }
  for (const bin of desktopBins) if (existsSync(bin)) folders.push(bin);
  return [...new Set(folders)];
}

/** `path` with Docker's folders added once, after what was there (§3.1). */
export function withDockerFolders(path: string, docker: string, desktopBins = DOCKER_DESKTOP_BINS): string {
  const folders = path.split(delimiter).filter(Boolean);
  return [...folders, ...dockerFolders(docker, desktopBins).filter((f) => !folders.includes(f))].join(delimiter);
}
