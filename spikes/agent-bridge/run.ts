/**
 * Runs one agent turn as its own process group and makes sure nothing outlives it.
 * The prompt goes on stdin; stdout is delivered line by line. Cancelling sends SIGTERM to the group, then SIGKILL
 * after a grace period. When the agent exits, for any reason, whatever is left in its group (an MCP server that
 * didn't stop, a stray child) is killed too. POSIX only: Windows would use `taskkill /T /F` and is unverified.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

export type TurnResult = { code: number | null; signal: NodeJS.Signals | null; cancelled: boolean; atCancel?: number; leftover: number };

export type TurnOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  onLine: (line: string) => void;
  graceMs?: number;
};

/**
 * Processes still in a group, found by group id rather than by command line, so descendants count too.
 * pgrep exits 1 for "none"; anything else that isn't a match means the group couldn't be inspected.
 */
export function members(group: number): number {
  const r = spawnSync("pgrep", ["-g", String(group)], { encoding: "utf8" });
  if (r.status === 1) return 0;
  if (r.status !== 0) throw new Error(`Couldn't inspect process group ${group}.`);
  return r.stdout.trim().split("\n").filter(Boolean).length;
}

function killGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // The group is already empty.
  }
}

export function startTurn(o: TurnOptions): { cancel(): void; done: Promise<TurnResult> } {
  if (process.platform === "win32") throw new Error("The spike runs on POSIX only.");
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "inherit"], detached: true });
  const group = child.pid!;
  child.stdin.end(o.input);
  createInterface({ input: child.stdout }).on("line", o.onLine);

  let cancelled = false;
  let atCancel: number | undefined;
  let escalate: NodeJS.Timeout | undefined;
  const done = new Promise<TurnResult>((resolve) => {
    child.on("exit", (code, signal) => {
      clearTimeout(escalate);
      killGroup(group, "SIGKILL");
      setTimeout(() => resolve({ code, signal, cancelled, ...(atCancel === undefined ? {} : { atCancel }), leftover: members(group) }), 200);
    });
  });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    atCancel = members(group);
    killGroup(group, "SIGTERM");
    escalate = setTimeout(() => killGroup(group, "SIGKILL"), o.graceMs ?? 5000);
  };
  return { cancel, done };
}
