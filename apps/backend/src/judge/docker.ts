import { spawn } from "child_process";
export type SpawnCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function getJudgeTimeoutMs(): number {
  const raw = process.env.JUDGE_TIMEOUT_MS;
  if (!raw) return 15000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 15000;
  return Math.min(Math.floor(n), 30_000);
}

function resolveDockerBin(): string {
  const env = typeof process.env.DOCKER_PATH === "string" ? process.env.DOCKER_PATH.trim() : "";
  if (env) return env;
  return "docker";
}

function killProcessBestEffort(proc: ReturnType<typeof spawn>) {
  try {
    if (process.platform === "win32") {
      // Windows: SIGKILL isn't a thing; kill() uses TerminateProcess.
      proc.kill();
      return;
    }
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

export async function spawnCapture(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SpawnCaptureResult> {
  const maxBufferBytes = typeof opts.maxBufferBytes === "number" ? Math.max(64 * 1024, Math.floor(opts.maxBufferBytes)) : 1024 * 1024;

  return new Promise((resolve) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const t = setTimeout(() => {
      timedOut = true;
      killProcessBestEffort(child);
    }, Math.max(1000, Math.floor(opts.timeoutMs)));

    const onData = (buf: Buffer, which: "stdout" | "stderr") => {
      const len = buf.length;
      if (which === "stdout") {
        if (stdoutBytes + len <= maxBufferBytes) stdoutChunks.push(buf);
        stdoutBytes += len;
      } else {
        if (stderrBytes + len <= maxBufferBytes) stderrChunks.push(buf);
        stderrBytes += len;
      }
      // If output is exploding, kill to prevent memory blowups.
      if (stdoutBytes + stderrBytes > maxBufferBytes * 4) {
        timedOut = true;
        killProcessBestEffort(child);
      }
    };

    child.stdout?.on("data", (b) => onData(b, "stdout"));
    child.stderr?.on("data", (b) => onData(b, "stderr"));

    const done = (exitCode: number) => {
      clearTimeout(t);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.on("close", (code) => done(typeof code === "number" ? code : 1));
    child.on("error", (e: any) => {
      clearTimeout(t);
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      resolve({ stdout: "", stderr: msg, exitCode: 1, timedOut: false });
    });
  });
}

/**
 * Resource limits applied to every sandbox container. The wall-clock timeout
 * alone cannot stop a fork bomb or memory balloon from freezing the host
 * before it fires; these caps contain them inside the container.
 */
export const CONTAINER_LIMIT_ARGS: readonly string[] = [
  "--pids-limit",
  "256",
  "--memory",
  "1g",
  "--memory-swap",
  "1g",
  "--cpus",
  "2",
  "--security-opt",
  "no-new-privileges",
];

export function withContainerLimits(args: string[]): string[] {
  if (args[0] !== "run") return args;
  return [args[0], ...CONTAINER_LIMIT_ARGS, ...args.slice(1)];
}

export async function runDocker(opts: {
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SpawnCaptureResult> {
  const cmd = resolveDockerBin();
  const extra = typeof opts.env === "object" && opts.env ? { env: opts.env } : {};
  return spawnCapture({ cmd, args: withContainerLimits(opts.args), cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...extra });
}
