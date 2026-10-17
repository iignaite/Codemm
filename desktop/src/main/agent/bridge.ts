// Runs the learner's agent CLI (DESIGN §3.1): argument arrays and no shell,
// no stdin, its own process group, stdout read as capped lines, and status
// commands that stop at a deadline and keep only what they read. The agent
// gets the app's environment unchanged (O1).
import { spawn, type ChildProcess } from 'node:child_process';

/** An agent or tool found on this computer. `js`: a Node script, run with the app itself as Node. */
export interface Executable {
  path: string;
  js: boolean;
}

/** The process to spawn for an executable: a Node script runs as `ELECTRON_RUN_AS_NODE=1 <app> <script>`. */
export function spawnable(exe: Executable, args: string[], runtime = process.execPath) {
  return exe.js
    ? { file: runtime, args: [exe.path, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    : { file: exe.path, args, env: { ...process.env } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a killed agent's output pipes may take to close. */
const CLOSE_GRACE_MS = 2000;
const windows = process.platform === 'win32';

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
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
    const code = await new Promise<number | null>((r) => spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }).on('close', r).on('error', () => r(null)));
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
}

/**
 * Runs one agent turn and resolves once it has exited. A cancelled run resolves once termination is confirmed
 * or found unconfirmed, never later: `stopped` is true only when the tree is gone and its output pipes closed
 * (a pipe still open means a descendant escaped). After it resolves, no callback runs.
 */
export function run<E>(exe: Executable, args: string[], parse: (line: string) => E[], options: RunOptions<E> = {}): Promise<RunResult> {
  const { onEvent, signal, cwd, maxLine = 1 << 20, killAfterMs = 3000, runtime } = options;
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
    const emit = (line: string) => {
      if (settled) return;
      try {
        for (const event of parse(line)) onEvent?.(event);
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
    child.stderr!.resume(); // drained, never shown or logged: it can carry account details
    child.on('error', reject);
    child.on('exit', () => (exited = true));
    child.on('close', (code) => {
      closed = true;
      for (const done of closing.splice(0)) done();
      if (stopping) return;
      if (buffer && !skipping && buffer.length <= maxLine) emit(buffer);
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
