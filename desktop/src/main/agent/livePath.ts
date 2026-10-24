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
/** How long a read may take: a slow or stuck reg.exe keeps the PATH as it is, so no screen waits on it longer. */
const READ_MS = 2_000;
/** After a read that hung or threw, how long until the next: polling screens never wait on a stuck reg.exe each time. */
const RETRY_MS = 30_000;

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
 * `current` exactly as it is, then each folder of `added` it doesn't have yet, ignoring case and a trailing backslash.
 * A folder reg.exe couldn't spell (a name outside its code page) is left out: it names no folder.
 */
export function mergePath(current: string, ...added: string[]): string {
  const key = (dir: string) => dir.toLowerCase().replace(/\\+$/, '');
  const seen = new Set(current.split(win32.delimiter).map(key));
  const extra: string[] = [];
  for (const dir of added.flatMap((p) => p.split(win32.delimiter))) {
    if (!dir || dir.includes('\uFFFD') || seen.has(key(dir))) continue;
    seen.add(key(dir));
    extra.push(dir);
  }
  if (!extra.length) return current;
  return current + (current === '' || current.endsWith(win32.delimiter) ? '' : win32.delimiter) + extra.join(win32.delimiter);
}

/**
 * Brings `env.PATH` up to date with the registry's. Calls at the same time share one read, and a read under 2 seconds
 * old is reused. A read that fails, or takes over 2 seconds, keeps the PATH as it is; after one that hung or threw, the
 * next waits 30 seconds. Off Windows it does nothing: a GUI app there gets no shell
 * PATH, and the usual folders cover it (find.ts).
 */
export function livePath(d: PathDeps): () => Promise<void> {
  let reading: Promise<void> | undefined;
  let readAt: number | undefined;

  let wait = FRESH_MS;

  /** Whether reg.exe answered in time. A missing value (exit 1) is an answer: there is nothing to add. */
  async function read(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), READ_MS)));
    try {
      const values = await Promise.race([Promise.all(KEYS.map(async (key) => regPath((await d.run(REG, ['query', key, '/v', 'Path'])) ?? '', d.env))), late]);
      if (values) d.env.PATH = mergePath(d.env.PATH ?? '', ...values);
      return values !== null;
    } finally {
      clearTimeout(timer);
    }
  }

  return () => {
    // CODEMM_TEST_FIXED_PATH is set only by the packaged and install tests, which stage a PATH with no Node, npm or Git.
    if (d.platform !== 'win32' || d.env.CODEMM_TEST_FIXED_PATH) return Promise.resolve();
    if (reading) return reading;
    if (readAt !== undefined && d.now() - readAt < wait) return Promise.resolve();
    reading = read()
      .catch(() => false)
      .then((answered) => {
        wait = answered ? FRESH_MS : RETRY_MS;
        readAt = d.now();
        reading = undefined;
      });
    return reading;
  };
}

/** The real runner: an argument array, no shell and no window. A stuck reg.exe is stopped when its read gives up. */
export function nodeRun(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: READ_MS }, (error, stdout) => resolve(error ? null : stdout)));
}
