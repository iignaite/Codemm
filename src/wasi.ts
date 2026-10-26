import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { infraError } from "./errors.js";
import type { WasiToolchain } from "./judge.js";

/**
 * The WASI engine (DESIGN §4.5): wasmtime runs a WASI track's code, with no Docker, VM or admin rights. The only
 * place Codemm starts wasmtime. Every run gets the same flags, whatever the track asked for.
 */

/**
 * wasmtime's path: CODEMM_WASMTIME (the desktop app's bundled copy), else `wasmtime` on PATH; undefined when neither runs.
 * One that ran is remembered for that setting, so a check doesn't ask again per case; one that didn't is asked again.
 */
export function wasmtimePath(): string | undefined {
  const configured = process.env.CODEMM_WASMTIME;
  if (found && found.configured === configured) return found.bin;
  for (const bin of configured ? [configured] : ["wasmtime"]) {
    if (spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0) {
      found = { configured, bin };
      return bin;
    }
  }
  return undefined;
}
let found: { configured: string | undefined; bin: string } | undefined;

/** What `wasmtime --version` says ("wasmtime 50.0.0 (…)"), for `doctor`. */
export function wasmtimeVersion(bin: string): string {
  return spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0] ?? "";
}

export const NO_WASMTIME = "wasmtime isn't installed, and this track runs on it. Install wasmtime, or set CODEMM_WASMTIME to its path, then retry.";

/** One program run: the toolchain, the host folder the learner's files are in (mapped at /work/src), and the limits. */
export type WasiRun = { toolchain: WasiToolchain; src: string; run: string; memoryMb: number; timeMs: number };

/** The full `wasmtime run` argument list. Pure, so the isolation flags are easy to test. */
export function wasiArgs(r: WasiRun): string[] {
  const args = [
    "run",
    "-W", `max-memory-size=${r.memoryMb * 2 ** 20}`,
    "-W", `timeout=${Math.ceil(r.timeMs)}ms`,
    "-S", "inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n",
    "-C", "cache=y",
    // First, so it is the program's first folder (fd 3) whatever the toolchain maps.
    "--dir", `${r.src}::/work/src`,
  ];
  for (const [guest, rel] of Object.entries(r.toolchain.dirs)) args.push("--dir", `${join(r.toolchain.root, rel)}::${guest}`);
  // Always NAME=VALUE: `--env NAME` alone would pass the host's value through.
  for (const [name, value] of Object.entries(r.toolchain.env)) args.push("--env", `${name}=${value}`);
  args.push(join(r.toolchain.root, r.toolchain.module), ...r.run.split(" ").filter(Boolean));
  return args;
}

/**
 * Makes a folder read-only, as an installed toolchain is: files 0444, folders 0555. WASI has no call that changes
 * permissions, so the program can't write there. Run folders get write permission back before removal (runs.ts).
 */
export function readOnly(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readOnly(path);
    else if (entry.isFile()) chmodSync(path, 0o444);
  }
  chmodSync(dir, 0o555);
}

/**
 * `input` is the program's whole stdin; without it, stdin stays open for typed text (Run). Past `outputCap` bytes of
 * stdout and stderr together the program is killed as a flood. The host kills it at `killMs` (default: a second after
 * the engine's own timer), and either stop is a time-out.
 */
export type WasiStart = WasiRun & { input?: Buffer; outputCap: number; killMs?: number };
/** `stdout` keeps at most `outputCap` bytes, `stderr` its first 4 KB. `exit` is 137 when Codemm killed it. */
export type WasiResult = { exit: number; stdout: Buffer; stderr: string; flooded: boolean; timedOut: boolean };
/** Output as it arrives, within the output cap. A handler that throws is dropped; the run goes on. */
export type WasiOutput = { stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void };
/** As a started container (sandbox.ts): `write` drops text that is too long, piles up unread, or comes after the end. */
export type StartedWasi = { write(text: string): boolean; end(): void; kill(): void; done: Promise<WasiResult> };

export const STDERR_BYTES = 4096;
// Run's typed-input bounds, as for containers (DESIGN §4.3).
const MAX_WRITE = 64 * 1024;
const MAX_PENDING_INPUT = 1024 * 1024;
/** wasmtime's report that its timer stopped the program; it comes last on stderr. */
const INTERRUPTED = /wasm trap: interrupt\s*$/;
/** Where wasmtime's own report of a trap begins on stderr. */
const TRAP_REPORT = "Error: failed to run main module";
/** wasmtime refusing Codemm's options (clap's words, exit 2): one older than the flags Codemm passes. */
const REFUSED = /^error: (?:unexpected argument|failed to parse -\w \/ --[\w-]+ option)/;

/** Starts one program on wasmtime, with every flag in wasiArgs, the output cap and the host kill. */
export function startWasi(run: WasiStart, output: WasiOutput = {}): StartedWasi {
  const bin = wasmtimePath();
  if (!bin) throw infraError(NO_WASMTIME, "no-wasmtime");
  readOnly(run.src);
  const child = spawn(bin, wasiArgs(run), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const handlers = { ...output };
  const chunks: Buffer[] = [];
  const errHead: Buffer[] = [];
  let errKept = 0;
  let errTail = "";
  let bytes = 0;
  let flooded = false;
  let timedOut = false;
  let ended = false;
  const tell = (stream: "stdout" | "stderr", b: Buffer) => {
    try {
      handlers[stream]?.(b);
    } catch {
      delete handlers[stream];
    }
  };
  const take = (stream: "stdout" | "stderr", b: Buffer) => {
    if (ended) return;
    const room = run.outputCap - bytes;
    const within = b.subarray(0, Math.max(0, room));
    if (within.length) tell(stream, within);
    if (stream === "stdout") chunks.push(within);
    else {
      if (errKept < STDERR_BYTES) errHead.push(b.subarray(0, STDERR_BYTES - errKept));
      errKept += b.length;
      errTail = (errTail + b.toString("latin1")).slice(-256);
    }
    bytes += b.length;
    if (bytes > run.outputCap) {
      flooded = true;
      stop();
    }
  };
  const stop = () => {
    ended = true;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (b: Buffer) => take("stdout", b));
  child.stderr.on("data", (b: Buffer) => take("stderr", b));
  // A program that exits without reading closes the pipe; what was left to write is dropped, not an error.
  child.stdin.on("error", () => undefined);
  if (run.input) child.stdin.end(run.input);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, run.killMs ?? run.timeMs + 1000);
  const done = new Promise<WasiResult>((resolve, reject) => {
    child.on("error", (e) => {
      ended = true;
      clearTimeout(timer);
      reject(infraError(`wasmtime couldn't start (${e.message.slice(0, 200)}), so nothing was recorded. Run \`codemm doctor\`.`, "no-wasmtime"));
    });
    child.on("close", (code) => {
      ended = true;
      clearTimeout(timer);
      let stderr = new StringDecoder("utf8").write(Buffer.concat(errHead));
      const stdout = Buffer.concat(chunks);
      if (code === 2 && stdout.length === 0 && REFUSED.test(stderr)) {
        reject(infraError("This wasmtime doesn't accept Codemm's options, so nothing was recorded. Install wasmtime 50 or later, or set CODEMM_WASMTIME to it, then retry.", "no-wasmtime"));
        return;
      }
      if (code !== 0 && code !== null && INTERRUPTED.test(errTail)) timedOut = true;
      // The time limit says why it stopped; wasmtime's report of the trap adds only its own paths and a backtrace.
      if (timedOut && stderr.includes(TRAP_REPORT)) stderr = stderr.slice(0, stderr.indexOf(TRAP_REPORT));
      resolve({ exit: code ?? 137, stdout, stderr, flooded, timedOut });
    });
  });
  return {
    write: (text) => {
      const size = Buffer.byteLength(text);
      if (ended || run.input || !child.stdin.writable || size > MAX_WRITE || child.stdin.writableLength + size > MAX_PENDING_INPUT) return false;
      child.stdin.write(text);
      return true;
    },
    end: () => {
      if (!ended && !run.input && child.stdin.writable) child.stdin.end();
    },
    kill: stop,
    done,
  };
}
