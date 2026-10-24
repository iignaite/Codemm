// Windows' PATH as installers leave it in the registry, merged into this process's own (DESIGN §3.1). A process
// keeps the environment it started with, so without this an agent or Docker installed while Codemm is open stays
// "Not installed" until Codemm restarts. Agent jobs and core's docker calls inherit process.env, so they see it too.
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

export interface PathDeps {
  platform: NodeJS.Platform;
  /** Whose PATH is brought up to date, and where %NAME% is expanded from: process.env in the app. */
  env: NodeJS.ProcessEnv;
  /** Runs a program to its end: what it printed, or null when it failed (reg.exe exits 1 when there is no value). */
  run(file: string, args: string[]): Promise<string | null>;
  now(): number;
}

/** Windows' own tool by absolute path: one earlier on PATH can't stand in for it. */
const REG = 'C:\\Windows\\System32\\reg.exe';
/** The machine's PATH, then the user's: the order Windows builds a new process's PATH in. */
const KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
/** Connect and Check this computer look every few seconds: a read this young is reused. */
const FRESH_MS = 2_000;

/** %NAME% from `env`, ignoring case. A name `env` doesn't have stays as it is, as Windows leaves it. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  const names = new Map(Object.entries(env).map(([name, v]) => [name.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => names.get(name.toLowerCase()) ?? whole);
}

/** The Path value in one `reg query <key> /v Path` answer, expanded when it is REG_EXPAND_SZ; '' when there is none. */
export function regPath(output: string, env: NodeJS.ProcessEnv): string {
  const m = /^[ \t]+Path[ \t]+(REG_SZ|REG_EXPAND_SZ)[ \t]+(.*)$/im.exec(output);
  if (!m) return '';
  const value = m[2].trim();
  return m[1].toUpperCase() === 'REG_EXPAND_SZ' ? expand(value, env) : value;
}

/**
 * `current`, then each folder of `added` it doesn't have yet, ignoring case and a trailing backslash. A folder reg.exe
 * couldn't spell (a name outside its code page) is left out: it names no folder.
 */
export function mergePath(current: string, ...added: string[]): string {
  const key = (dir: string) => dir.toLowerCase().replace(/\\+$/, '');
  const dirs = current.split(win32.delimiter).filter(Boolean);
  const seen = new Set(dirs.map(key));
  for (const dir of added.flatMap((p) => p.split(win32.delimiter))) {
    if (!dir || dir.includes('\uFFFD') || seen.has(key(dir))) continue;
    seen.add(key(dir));
    dirs.push(dir);
  }
  return dirs.join(win32.delimiter);
}

/**
 * Brings `env.PATH` up to date with the registry's. Calls at the same time share one read, and a read under 2 seconds
 * old is reused. A read that fails keeps the PATH as it is. Off Windows it does nothing: a GUI app there gets no shell
 * PATH, and the usual folders cover it (find.ts).
 */
export function livePath(d: PathDeps): () => Promise<void> {
  let reading: Promise<void> | undefined;
  let readAt: number | undefined;

  async function read() {
    const [machine, user] = await Promise.all(KEYS.map(async (key) => regPath((await d.run(REG, ['query', key, '/v', 'Path'])) ?? '', d.env)));
    d.env.PATH = mergePath(d.env.PATH ?? '', machine, user);
  }

  return () => {
    if (d.platform !== 'win32') return Promise.resolve();
    if (reading) return reading;
    if (readAt !== undefined && d.now() - readAt < FRESH_MS) return Promise.resolve();
    reading = read()
      .catch(() => undefined)
      .finally(() => {
        readAt = d.now();
        reading = undefined;
      });
    return reading;
  };
}

/** The real runner: an argument array, no shell and no window, bounded so a stuck read never holds up a lookup. */
export function nodeRun(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout)));
}
