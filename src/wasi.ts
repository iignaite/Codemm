import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { CodemmError, infraError } from "./errors.js";
import type { WasiToolchain } from "./judge.js";
import type { RunFolder } from "./runs.js";
import { codemmHome } from "./store.js";

/**
 * The WASI engine (DESIGN §4.5): wasmtime runs a WASI track's code, with no Docker, VM or admin rights. The only
 * place Codemm starts wasmtime. Every run gets the same flags, whatever the track asked for.
 */

/** The wasmtime major version Codemm passes its flags to. */
export const WASMTIME_MAJOR = 50;
const VERSION_MS = 10_000;
const COMPILE_MS = 5 * 60_000;

/**
 * wasmtime starts with an empty environment, so no WASMTIME_* or RUST_* setting reaches it. Windows needs SystemRoot to
 * start a process at all.
 */
const engineEnv = (): NodeJS.ProcessEnv => (process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {});

/** A name as the OS would find it on PATH, as an absolute path: wasmtime starts with no PATH of its own. */
function onPath(name: string): string | undefined {
  if (/[\\/]/.test(name)) return resolve(name);
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const path = join(dir, name + ext);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

export type Wasmtime = { bin: string; version: string };

/** wasmtime and its version ("50.0.0"), or undefined when it isn't there or doesn't answer `--version` within 10 s. */
function findWasmtime(): Wasmtime | undefined {
  const key = `${process.env.CODEMM_WASMTIME ?? ""}\0${process.env.PATH ?? ""}`;
  if (found?.key === key) return found.wasmtime;
  const bin = onPath(process.env.CODEMM_WASMTIME || "wasmtime");
  if (!bin) return undefined;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: VERSION_MS, env: engineEnv(), windowsHide: true });
  const version = r.status === 0 ? /^wasmtime (\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] : undefined;
  if (!version) return undefined;
  // Remembered for this setting, so a check doesn't ask again per case; a lookup that failed is asked again.
  found = { key, wasmtime: { bin, version } };
  return found.wasmtime;
}
let found: { key: string; wasmtime: Wasmtime } | undefined;

/** wasmtime's path: CODEMM_WASMTIME (the desktop app's bundled copy), else `wasmtime` on PATH; undefined when neither runs. */
export const wasmtimePath = (): string | undefined => findWasmtime()?.bin;

export const NO_WASMTIME = `wasmtime isn't installed, and WASI tracks run on it. Install wasmtime ${WASMTIME_MAJOR}, or set CODEMM_WASMTIME to its path, then retry.`;

/** wasmtime at the version Codemm needs, or the infrastructure error `no-wasmtime`. */
export function wasmtime(): Wasmtime {
  const w = findWasmtime();
  if (!w) throw infraError(NO_WASMTIME, "no-wasmtime");
  if (Number(w.version.split(".")[0]) !== WASMTIME_MAJOR) {
    throw infraError(`This computer's wasmtime is version ${w.version}, and Codemm needs wasmtime ${WASMTIME_MAJOR}. Install it, or set CODEMM_WASMTIME to it, then retry.`, "no-wasmtime");
  }
  return w;
}

/** Where a toolchain's module is kept compiled for one wasmtime version: outside the toolchain folder, never mapped. */
export const compiledPath = (sha256: string, version: string) => join(codemmHome(), "toolchains", "compiled", `${sha256}-${version}.cwasm`);

/**
 * Compiles a toolchain's module for this wasmtime (DESIGN §4.5), so no case pays for compiling. Written to a temp file,
 * then renamed. A module that doesn't compile is the toolchain's fault (a plain CodemmError); a full disk, a slow
 * computer or no wasmtime are this computer's.
 */
export async function compileModule(toolchain: WasiToolchain): Promise<string> {
  const w = wasmtime();
  const out = compiledPath(toolchain.sha256, w.version);
  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    const r = await collect(w.bin, ["compile", "-W", "epoch-interruption=y", join(toolchain.root, toolchain.module), "-o", temp], COMPILE_MS);
    const last = r.output.trim().split("\n").at(-1)?.trim().slice(0, 300) ?? "";
    if (r.timedOut) throw infraError("Compiling the track's toolchain took more than 5 minutes, so nothing was recorded. Close other programs, then retry.", "check-timeout");
    if (/no space left|os error (?:28|112)\b|not enough space/i.test(r.output)) throw infraError(`The disk is full, so the track's toolchain couldn't be compiled (${last}). Free some space, then retry.`, "host-disk");
    if (r.exit !== 0) throw new CodemmError(`The toolchain's module didn't compile with wasmtime ${w.version} (${last || `exit ${r.exit}`}).`);
    renameSync(temp, out);
    return out;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A toolchain ready to run: wasmtime, and the module compiled for it. */
export type WasiEngine = { bin: string; compiled: string };

/**
 * The checks before each set (DESIGN §4.5): wasmtime 50, the toolchain folder, its module and every `dirs` folder.
 * `ready` says whether the compiled module is there; prepareWasi compiles it when it isn't.
 */
export function checkWasi(toolchain: WasiToolchain): WasiEngine & { ready: boolean } {
  const w = wasmtime();
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  const whole = isDir(toolchain.root) && existsSync(join(toolchain.root, toolchain.module)) && Object.values(toolchain.dirs).every((rel) => isDir(join(toolchain.root, rel)));
  if (!whole) throw new CodemmError("This track's language files are missing, so nothing was recorded. Rebuild the track in Codemm, then try again.", "image-missing");
  const compiled = compiledPath(toolchain.sha256, w.version);
  return { bin: w.bin, compiled, ready: existsSync(compiled) };
}

/** checkWasi, then the compiled module, compiled now (outside any limit) when this wasmtime has none yet. */
export async function prepareWasi(toolchain: WasiToolchain): Promise<WasiEngine> {
  const { ready, ...engine } = checkWasi(toolchain);
  if (!ready) await compileModule(toolchain);
  return engine;
}

/** One program run: the engine, the toolchain's folders and environment, the host folder mapped at /work/src, the limits. */
export type WasiRun = { engine: WasiEngine; toolchain: WasiToolchain; src: string; run: string; memoryMb: number; timeMs: number };

/** The full `wasmtime run` argument list. Pure, so the isolation flags are easy to test. */
export function wasiArgs(r: WasiRun): string[] {
  const args = [
    "run",
    "--allow-precompiled", "-C", "cache=n",
    "-W", `max-memory-size=${r.memoryMb * 2 ** 20}`,
    // One memory, so max-memory-size is the program's whole memory; tables and instances can't add much beside it.
    "-W", "max-memories=1,max-tables=8,max-table-elements=1000000,max-instances=4",
    "-W", `timeout=${Math.ceil(r.timeMs)}ms`,
    "-S", "inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n,http=n",
    // First, so it is the program's first folder (fd 3) whatever the toolchain maps.
    "--dir", `${r.src}::/work/src`,
  ];
  for (const [guest, rel] of Object.entries(r.toolchain.dirs)) args.push("--dir", `${join(r.toolchain.root, rel)}::${guest}`);
  // Always NAME=VALUE: `--env NAME` alone would pass the host's value through.
  for (const [name, value] of Object.entries(r.toolchain.env)) args.push("--env", `${name}=${value}`);
  args.push(r.engine.compiled, ...r.run.split(" ").filter(Boolean));
  return args;
}

/** On Windows a folder's mode doesn't stop new files, so a sealed folder also denies everyone writing, inherited below it. */
const icacls = (args: string[]) => {
  const r = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls: ${(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split("\n")[0]}`);
};
const EVERYONE = "*S-1-1-0";
/**
 * What a sealed folder denies everyone on Windows, inherited by everything under it: writing data or attributes, adding
 * files or folders and deleting what's in a folder, and deleting files. The specific rights, not icacls' generic W,
 * which includes SYNCHRONIZE and READ_CONTROL and so denies every open; and DELETE on files only, since wasmtime asks
 * for it when it opens a folder. A file can't be deleted while both its DELETE and its folder's DELETE_CHILD are denied.
 */
const DENIED = ["(OI)(CI)(WD,AD,WEA,WA,DC)", "(OI)(IO)(D)"];

/** Sets a tree's modes, folders after what's in them (unless `folder` is undefined). Links and special files are left as they are. */
function modes(dir: string, file: number, folder: number | undefined): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) modes(path, file, folder);
    else if (entry.isFile()) chmodSync(path, file);
  }
  if (folder !== undefined) chmodSync(dir, folder);
}

const sealFailed = (e: unknown) =>
  infraError(`Codemm couldn't make its files read-only on this disk (${(e as Error).message.slice(0, 200)}), so nothing was recorded. Keep Codemm's home on a disk with file permissions (not FAT or exFAT), then retry.`, "wasi-seal");

/**
 * Seals everything under `dir`, but not `dir` itself, read-only (DESIGN §4.5): files 0444 and folders 0555. On
 * Windows, files are read-only and each top-level folder gets one deny entry that everything under it inherits.
 * wasmtime maps folders read-write and WASI can't change permissions, so the program can't write there. `dir` stays writable so it can be renamed (a toolchain's temp folder) and is never
 * mapped. A seal that fails, or that the disk ignores, is the infrastructure error `wasi-seal`.
 */
export function sealReadOnly(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // On Windows a folder's mode is only a read-only attribute, which stops nothing there; the deny entry, inherited
        // by everything under it, is what seals it.
        if (process.platform === "win32") {
          modes(path, 0o444, undefined);
          for (const rights of DENIED) icacls([path, "/deny", `${EVERYONE}:${rights}`]);
        } else modes(path, 0o444, 0o555);
      } else if (entry.isFile()) chmodSync(path, 0o444);
      // A disk without permissions (FAT, exFAT) can accept the change and keep nothing. Windows reports its deny entry.
      if (process.platform !== "win32" && (entry.isDirectory() || entry.isFile()) && (lstatSync(path).mode & 0o222) !== 0) throw new Error(`${entry.name} stayed writable`);
    }
  } catch (e) {
    throw sealFailed(e);
  }
}

/** Undoes sealReadOnly on everything under `dir`, so it can be changed or removed. */
export function unseal(dir: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (process.platform === "win32") icacls([path, "/remove:d", EVERYONE]);
        modes(path, 0o644, 0o755);
      } else if (entry.isFile()) chmodSync(path, 0o644);
    }
  } catch (e) {
    throw sealFailed(e);
  }
}

/** Removes a run folder whose contents were sealed. Best effort, as every run folder's removal is (runs.ts). */
export function removeSealed(folder: RunFolder): void {
  try {
    unseal(folder.dir);
  } catch {
    // The removal below, or the next run's leftover sweep, tries again.
  }
  folder.remove();
}

/**
 * `input` is the program's whole stdin; without it, stdin stays open for typed text (Run). Past `outputCap` bytes of
 * stdout and stderr together the program is killed as a flood. The host kills it at `killMs` (default: a second after
 * the engine's own timer).
 */
export type WasiStart = WasiRun & { input?: Buffer; outputCap: number; killMs?: number };
/**
 * `stdout` keeps at most `outputCap` bytes and `stderr` its first 4 KB, without wasmtime's report of a trap. `exit` is
 * 137 when Codemm killed it. `timedOut`: the host killed it, or it failed after its time limit had passed.
 */
export type WasiResult = { exit: number; stdout: Buffer; stderr: string; flooded: boolean; timedOut: boolean };
/** Output as it arrives, within the output cap. A handler that throws is dropped; the run goes on. */
export type WasiOutput = { stdout?: (chunk: Buffer) => void; stderr?: (chunk: Buffer) => void };
/** As a started container (sandbox.ts): `write` drops text that is too long, piles up unread, or comes after the end. */
export type StartedWasi = { write(text: string): boolean; end(): void; kill(): void; done: Promise<WasiResult> };

const STDERR_BYTES = 4096;
// Run's typed-input bounds, as for containers (DESIGN §4.3).
const MAX_WRITE = 64 * 1024;
const MAX_PENDING_INPUT = 1024 * 1024;

/** Starts one program on wasmtime, with every flag in wasiArgs, the output cap and the host kill. */
export function startWasi(run: WasiStart, output: WasiOutput = {}): StartedWasi {
  const started = Date.now();
  const child = spawn(run.engine.bin, wasiArgs(run), { stdio: ["pipe", "pipe", "pipe"], env: engineEnv(), windowsHide: true });
  const handlers = { ...output };
  const chunks: Buffer[] = [];
  const errHead: Buffer[] = [];
  let errKept = 0;
  let bytes = 0;
  let flooded = false;
  let killed = false;
  let ended = false;
  const tell = (stream: "stdout" | "stderr", b: Buffer) => {
    try {
      handlers[stream]?.(b);
    } catch {
      delete handlers[stream];
    }
  };
  const errors = withoutTrapReport((b) => {
    if (errKept < STDERR_BYTES) errHead.push(b.subarray(0, STDERR_BYTES - errKept));
    errKept += b.length;
    tell("stderr", b);
  });
  const stop = () => {
    ended = true;
    child.kill("SIGKILL");
  };
  const take = (stream: "stdout" | "stderr", b: Buffer) => {
    if (ended) return;
    const within = b.subarray(0, Math.max(0, run.outputCap - bytes));
    if (stream === "stdout") {
      chunks.push(within);
      if (within.length) tell("stdout", within);
    } else errors.write(within);
    bytes += b.length;
    if (bytes > run.outputCap) {
      flooded = true;
      stop();
    }
  };
  // Both pipes are read to the end, so a program that prints a lot of errors is never stopped by a full pipe.
  child.stdout.on("data", (b: Buffer) => take("stdout", b));
  child.stderr.on("data", (b: Buffer) => take("stderr", b));
  // A program that exits without reading closes the pipe; what was left to write is dropped, not an error.
  child.stdin.on("error", () => undefined);
  if (run.input) child.stdin.end(run.input);
  const timer = setTimeout(() => {
    killed = true;
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
      errors.end();
      const timedOut = killed || (code !== 0 && Date.now() - started >= run.timeMs);
      resolve({ exit: code ?? 137, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errHead).toString("utf8"), flooded, timedOut });
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

/** Where wasmtime's own report of a trap begins on stderr: its paths and a backtrace, which §4.2's words replace. */
const TRAP_REPORT = Buffer.from("Error: failed to run main module");

/** Passes stderr on as it streams, until wasmtime's report of a trap, which comes last; a tail that could start it waits. */
function withoutTrapReport(out: (b: Buffer) => void) {
  let held = Buffer.alloc(0);
  let cut = false;
  return {
    write(chunk: Buffer) {
      if (cut || chunk.length === 0) return;
      const buf = held.length ? Buffer.concat([held, chunk]) : chunk;
      const at = buf.indexOf(TRAP_REPORT);
      if (at >= 0) {
        cut = true;
        held = Buffer.alloc(0);
        if (at > 0) out(buf.subarray(0, at));
        return;
      }
      let keep = Math.min(buf.length, TRAP_REPORT.length - 1);
      while (keep > 0 && !TRAP_REPORT.subarray(0, keep).equals(buf.subarray(buf.length - keep))) keep--;
      held = Buffer.from(buf.subarray(buf.length - keep));
      if (buf.length > keep) out(buf.subarray(0, buf.length - keep));
    },
    end() {
      if (!cut && held.length) out(held);
      held = Buffer.alloc(0);
    },
  };
}

/** Runs wasmtime for housekeeping (compiling), not for untrusted code: its exit, its output, and whether it timed out. */
function collect(bin: string, args: string[], timeoutMs: number): Promise<{ exit: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: engineEnv(), windowsHide: true });
    let output = "";
    let timedOut = false;
    const keep = (b: Buffer) => {
      output = (output + b.toString("utf8")).slice(-16_384);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit: -1, output: e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exit: code ?? -1, output, timedOut });
    });
  });
}
