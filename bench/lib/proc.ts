/** Subprocesses for the bench: argument arrays only, a clean environment, and a hard timeout. */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";

/** Credentials and host-session variables that must not reach an agent: runs use the owner's own CLI logins only. */
const STRIP = /^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|MCP_)/;

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export type ProcResult = { code: number | null; timedOut: boolean; wallMs: number };

/** Runs a command with stdin closed, streaming stdout to `stdoutPath`. Kills the whole process group at the timeout. */
export function run(command: string, args: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; stdoutPath: string; stderrPath: string }): Promise<ProcResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.pipe(createWriteStream(o.stdoutPath));
    child.stderr.pipe(createWriteStream(o.stderrPath));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }, o.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, wallMs: Date.now() - started });
    });
  });
}

/** A short synchronous command whose output the bench needs (docker, git, codemm). */
export function capture(command: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): { code: number | null; out: string } {
  const r = spawnSync(command, args, { cwd: o.cwd, env: o.env ?? cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
