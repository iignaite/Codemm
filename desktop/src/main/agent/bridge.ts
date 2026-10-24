// Runs the learner's agent CLI (DESIGN §3.1): argument arrays and no shell,
// no stdin, its own process group, stdout read as capped lines, and status
// commands that stop at a deadline and keep only what they read. The agent
// gets the app's environment unchanged (O1).
import { spawn, type ChildProcess } from 'node:child_process';
import { TASKKILL } from '../windows';

/** An agent or tool found on this computer. `js`: a Node script, run with the app itself as Node. */
export interface Executable {
  path: string;
  js: boolean;
  /** Words before the caller's arguments, and environment added for them: Cursor's own Node on its script (§3.1). */
  args?: string[];
  env?: Record<string, string>;
}

/** The program, arguments and added environment for an executable: a Node script runs as `ELECTRON_RUN_AS_NODE=1 <app> <script>`. */
export function command(exe: Executable, args: string[], runtime = process.execPath) {
  const words = [...(exe.args ?? []), ...args];
  return exe.js
    ? { file: runtime, args: [exe.path, ...words], env: { ELECTRON_RUN_AS_NODE: '1', ...exe.env } }
    : { file: exe.path, args: words, env: { ...exe.env } };
}

/** The process to spawn for an executable, with the app's environment and what the executable adds. */
export function spawnable(exe: Executable, args: string[], runtime = process.execPath) {
  const target = command(exe, args, runtime);
  return { ...target, env: { ...process.env, ...target.env } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a killed agent's output pipes may take to close. */
const CLOSE_GRACE_MS = 2000;
const windows = process.platform === 'win32';

/** Whether any member of the process group still exists. Only ESRCH means none; EPERM means one runs under other credentials. */
export function groupAlive(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  try {
    kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** How long a tree kill may take before it counts as unconfirmed. */
const TREE_KILL_MS = 15_000;

/** A promise's value, or `fallback` once `ms` pass without one. */
export function withDeadline<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Kills the agent's process tree (§3.1). True only when the kill is confirmed: on POSIX the group is gone
 * (SIGTERM, then SIGKILL); on Windows `taskkill /T /F` exited 0 for a parent that was still running.
 */
async function killTree(child: ChildProcess, killAfterMs: number, parentExited: boolean): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (windows) {
    // With the parent already gone, its tree can't be found or checked.
    if (parentExited) return false;
    const taskkill = spawn(TASKKILL, ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    const code = await withDeadline(new Promise<number | null>((r) => taskkill.on('close', r).on('error', () => r(null))), TREE_KILL_MS, null);
    if (code === null) taskkill.kill();
    return code === 0;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  const start = Date.now();
  let killed = false;
  while (groupAlive(pid) && Date.now() - start < killAfterMs + 5000) {
    if (!killed && Date.now() - start >= killAfterMs) {
      signal('SIGKILL');
      killed = true;
    }
    await sleep(50);
  }
  return !groupAlive(pid);
}

export interface RunResult {
  code: number | null;
  cancelled: boolean;
  /** For a cancelled run: true only when termination is confirmed. Anything else is unconfirmed (§3.1). */
  stopped?: boolean;
}

export interface RunOptions<E> {
  onEvent?: (event: E) => void;
  signal?: AbortSignal;
  cwd?: string;
  maxLine?: number;
  killAfterMs?: number;
  runtime?: string;
  /** Reads stderr lines for known failures; without it stderr is only drained. */
  errors?: (line: string) => E[];
}

/**
 * Runs one agent turn and resolves once it has exited. A cancelled run resolves once termination is confirmed
 * or found unconfirmed, never later: `stopped` is true only when the tree is gone and its output pipes closed
 * (a pipe still open means a descendant escaped). After it resolves, no callback runs.
 */
export function run<E>(exe: Executable, args: string[], parse: (line: string) => E[], options: RunOptions<E> = {}): Promise<RunResult> {
  const { onEvent, signal, cwd, maxLine = 1 << 20, killAfterMs = 3000, runtime, errors } = options;
  if (signal?.aborted) return Promise.resolve({ code: null, cancelled: true });
  const target = spawnable(exe, args, runtime);
  return new Promise((resolve, reject) => {
    // The agent leads a new process group, so cancelling also stops its MCP server and tools.
    const child = spawn(target.file, target.args, { cwd, env: target.env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true });
    let buffer = '';
    let skipping = false;
    let stopping: Promise<boolean> | undefined;
    let settled = false;
    let exited = false;
    let closed = false;
    const closing: (() => void)[] = [];
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      child.stdout!.removeAllListeners('data');
      resolve(result);
    };
    /** Whether the output pipes close within a grace period: every holder of them is gone. */
    const pipesClose = () =>
      new Promise<boolean>((r) => {
        if (closed) return r(true);
        const timer = setTimeout(() => r(false), CLOSE_GRACE_MS);
        closing.push(() => {
          clearTimeout(timer);
          r(true);
        });
      });
    const cancel = () => {
      if (stopping || settled) return;
      stopping = killTree(child, killAfterMs, exited).then(async (killed) => killed && (await pipesClose()));
      void stopping.then((stopped) => settle({ code: null, cancelled: true, stopped }));
    };
    const emit = (line: string, read = parse) => {
      if (settled) return;
      try {
        for (const event of read(line)) onEvent?.(event);
      } catch {
        // a line the parser can't read is skipped
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (!skipping && end <= maxLine) emit(buffer.slice(0, end));
        skipping = false;
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > maxLine) {
        buffer = '';
        skipping = true;
      }
    });
    // Drained, never shown or logged: it can carry account details. Only `errors` reads it, for known failures.
    if (errors) {
      let pending = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop()!.slice(-maxLine);
        for (const line of lines) emit(line.slice(0, maxLine), errors);
      });
      child.stderr!.on('end', () => pending && emit(pending, errors));
    } else child.stderr!.resume();
    child.on('error', reject);
    child.on('exit', () => (exited = true));
    child.on('close', (code) => {
      closed = true;
      for (const done of closing.splice(0)) done();
      if (stopping) return;
      if (buffer && !skipping && buffer.length <= maxLine) emit(buffer);
      // The last line may have asked to cancel: then the cancel settles, once its termination is known.
      if (stopping) return;
      settle({ code, cancelled: false });
    });
  });
}

/**
 * Runs one of the agent's own commands (sign-in status, --version) and returns only what `read` keeps.
 * Its raw output is dropped: status output can hold an email address. Null when it can't run or misses the deadline.
 */
export function ask<T>(exe: Executable, args: string[], read: (r: { code: number | null; output: string }) => T, { timeoutMs = 10_000, maxOutput = 65_536, runtime }: { timeoutMs?: number; maxOutput?: number; runtime?: string } = {}): Promise<T | null> {
  const target = spawnable(exe, args, runtime);
  return new Promise((resolve) => {
    const child = spawn(target.file, target.args, { env: target.env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true });
    let output = '';
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The deadline settles the answer even if a grandchild keeps the pipes open; the group is stopped in the background.
    const timer = setTimeout(() => {
      finish(null);
      void killTree(child, 0, false);
    }, timeoutMs);
    const collect = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(0, maxOutput);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(read({ code, output })));
  });
}
