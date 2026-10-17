// Finds an agent CLI or Docker on this computer (DESIGN §3.1). GUI apps don't
// load shell profiles, so besides PATH this looks in the usual install folders.
// A `#!/usr/bin/env node` launcher, or an npm `.cmd` shim on Windows (never
// run, because that needs a shell), becomes a Node script the app runs itself.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
}

export function here(): Where {
  return { platform: process.platform, path: process.env.PATH ?? '', home: homedir(), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA };
}

/** The usual install folders, after PATH. */
function folders(w: Where): string[] {
  if (w.platform === 'win32') {
    return [
      w.appData && join(w.appData, 'npm'),
      w.localAppData && join(w.localAppData, 'Programs'),
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
    '/Applications/Docker.app/Contents/Resources/bin',
  ];
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
    const head = readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 200);
    return /^#!.*\bnode\b/.test(head);
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
