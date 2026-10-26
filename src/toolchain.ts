import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, type Stats, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { CodemmError, infraError, type InfraCode } from "./errors.js";
import type { WasiSpec } from "./schemas.js";
import * as store from "./store.js";

/**
 * A WASI track's toolchain (DESIGN §4.5): downloaded over https, checked against its SHA-256 before anything is
 * unpacked, unpacked with the system tar, made read-only and stored once per digest under $CODEMM_HOME/toolchains/.
 * A plain CodemmError is the track's problem (gates report it as gate "valid"); this computer's network or disk
 * throws with its infrastructure code.
 */

/** `fetch`, or a stand-in for tests. Redirects come back to be checked (`redirect: "manual"`). */
export type Fetcher = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

export const MAX_DOWNLOAD_BYTES = 256 * 1024 ** 2;
export const MAX_UNPACKED_BYTES = 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const UNPACK_TIMEOUT_MS = 600_000;
const MAX_REDIRECTS = 5;
/** Room for the download and everything it unpacks to. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const MB = 1024 ** 2;

type Options = { fetcher?: Fetcher; timeoutMs?: number; maxDownload?: number; maxUnpacked?: number };

/** The toolchain's folder, downloading and storing it first unless a folder for its digest is already there. */
export async function ensureToolchain(wasi: Pick<WasiSpec, "url" | "sha256" | "module" | "dirs">, options: Options = {}): Promise<string> {
  const dir = store.toolchainDir(wasi.sha256);
  if (!existsSync(dir)) await install(wasi, dir, options);
  assertLayout(dir, wasi);
  return dir;
}

async function install(wasi: Pick<WasiSpec, "url" | "sha256" | "module" | "dirs">, dir: string, options: Options): Promise<void> {
  const parent = store.toolchainsDir();
  store.assertFreeSpace(parent, MIN_FREE_BYTES);
  const staging = mkdtempSync(join(parent, ".staging-"));
  const file = `${staging}.download`;
  try {
    await download(wasi.url, file, wasi.sha256, options);
    if (wasi.url.endsWith(".wasm")) renameSync(file, join(staging, wasi.module));
    else await unpack(file, staging, options.maxUnpacked ?? MAX_UNPACKED_BYTES);
    assertLayout(staging, wasi);
    try {
      renameSync(staging, dir);
    } catch (e) {
      // Another install stored the same digest first; that folder is used as it is.
      if (!existsSync(dir)) throw e;
      return;
    }
    // A read-only folder can't be renamed (macOS), so it is sealed once in place. A folder that can't be sealed is
    // never used: a program could change it for every later check.
    try {
      seal(dir);
    } catch (e) {
      removeTree(dir);
      throw infraError(`The toolchain couldn't be made read-only, so nothing was installed: ${(e as Error).message}`, "host-disk");
    }
  } finally {
    rmSync(file, { force: true });
    if (existsSync(staging)) removeTree(staging);
  }
}

// ---------- download ----------

async function download(url: string, file: string, sha256: string, { fetcher = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxDownload = MAX_DOWNLOAD_BYTES }: Options): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const tooBig = () => new CodemmError(`The file at wasi.url is larger than ${maxDownload / MB} MB, the most Codemm downloads for a toolchain.`);
  try {
    const response = await follow(url, fetcher, controller.signal);
    if (Number(response.headers.get("content-length") ?? 0) > maxDownload) {
      await response.body?.cancel().catch(() => undefined);
      throw tooBig();
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const out = await open(file, "wx", 0o600);
    try {
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > maxDownload) {
          controller.abort();
          throw tooBig();
        }
        hash.update(chunk);
        await out.write(chunk);
      }
    } finally {
      await out.close();
    }
    const actual = hash.digest("hex");
    if (actual !== sha256) {
      throw new CodemmError(`wasi.sha256 is ${sha256}, but the file at wasi.url has SHA-256 ${actual}. Check the link, and put the SHA-256 of the file it serves in wasi.sha256.`);
    }
  } catch (e) {
    if (e instanceof CodemmError) throw e;
    throw networkError(e, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

/** The response for `url`, following at most 5 redirects, each to https. */
async function follow(url: string, fetcher: Fetcher, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetcher(current, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password) {
        throw new CodemmError(`wasi.url redirects to a link that isn't https with no credentials (${next.protocol}//${next.host}). Use a link that stays on https.`);
      }
      current = next.href;
      continue;
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    const retry = "This is not a problem with the track files, so retry with the same files later.";
    if (response.status === 429) throw infraError(`The download server is limiting requests (HTTP 429), so nothing was installed. ${retry}`, "rate-limit");
    if (response.status >= 500) throw infraError(`The download server failed (HTTP ${response.status}), so nothing was installed. ${retry}`, "offline");
    throw new CodemmError(`Downloading wasi.url failed: the server answered HTTP ${response.status}. Check that the link names a file that exists.`);
  }
  throw new CodemmError(`wasi.url redirects more than ${MAX_REDIRECTS} times. Use the file's final link.`);
}

/** TLS errors that mean something on this computer intercepts the connection (§4.4); other certificate errors are the link's. */
const INTERCEPTED = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/;
const DROPPED = /^(ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/;
const BAD_CERT = /^(CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)$/;

function networkError(e: unknown, timedOut: boolean): CodemmError {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (e as { code?: string }).code ?? "";
  const retry = "This is not a problem with the track files, so retry with the same files.";
  if (BAD_CERT.test(code)) return new CodemmError(`The server at wasi.url has an invalid certificate (${code}). Use a link with a valid https certificate.`);
  const [message, infra]: [string, InfraCode] = timedOut
    ? ["The toolchain's download didn't finish in time: the connection may be slow.", "network-timeout"]
    : INTERCEPTED.test(code)
      ? ["The toolchain's download was refused: a certificate no trusted authority signed. A VPN, proxy or security software may be intercepting the connection.", "tls"]
      : DROPPED.test(code) || (e as Error).name === "AbortError"
        ? ["The toolchain's download timed out or dropped.", "network-timeout"]
        : [`The toolchain couldn't be downloaded (${code || (e as Error).message}): this computer may be offline, or a VPN, proxy or firewall may be blocking it.`, "offline"];
  return infraError(`${message} ${retry}`, infra);
}

// ---------- unpacking ----------

/** The system tar: bsdtar on macOS and Windows, which reads zip too. On Windows, its own, not one another tool put on PATH. */
export function systemTar(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

const freeBytes = (dir: string) => {
  const { bavail, bsize } = statfsSync(dir);
  return bavail * bsize;
};

/**
 * Unpacks `file` into `dir`, then refuses any link or special file and more than `max` bytes. While tar runs, the
 * free space it uses is watched, so an archive that expands without bound is stopped before it fills the disk.
 */
async function unpack(file: string, dir: string, max: number): Promise<void> {
  const before = freeBytes(dir);
  const tooBig = () => new CodemmError(`The archive at wasi.url unpacks to more than ${Math.round(max / MB)} MB, the most a toolchain may hold.`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(systemTar(), ["-xf", file, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let stopped: CodemmError | undefined;
    const stop = (why: CodemmError) => {
      stopped ??= why;
      child.kill("SIGKILL");
    };
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    // Blocks are allocated a little past the bytes, so allow some slack before stopping.
    const watch = setInterval(() => before - freeBytes(dir) > max + 64 * MB && stop(tooBig()), 200);
    const timer = setTimeout(() => stop(new CodemmError("The archive at wasi.url took more than 10 minutes to unpack.")), UNPACK_TIMEOUT_MS);
    const done = (e?: Error) => {
      clearInterval(watch);
      clearTimeout(timer);
      if (e) reject(e);
      else resolve();
    };
    child.on("error", (e) => done(new Error(`Couldn't run the system tar to unpack the toolchain: ${e.message}`)));
    child.on("close", (code) => {
      if (stopped) return done(stopped);
      if (code === 0) return done();
      const said = stderr.trim().split("\n").slice(-3).join("\n");
      if (/no space left/i.test(said)) return done(infraError("The disk filled up while unpacking the toolchain. Free some space, then retry.", "host-disk"));
      done(new CodemmError(`The archive at wasi.url didn't unpack with this computer's tar${said ? `:\n${said}` : "."}`));
    });
  });
  let total = 0;
  walk(dir, (_path, rel, stat) => {
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) {
      throw new CodemmError(`The archive at wasi.url holds a link or special file (${rel}). A toolchain may hold only files and folders.`);
    }
    total += stat.isFile() ? stat.size : 0;
    if (total > max) throw tooBig();
  });
}

/** Calls `visit` for every entry under `dir`, children after their folder, without following links. */
function walk(dir: string, visit: (path: string, rel: string, stat: Stats) => void, rel = ""): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const stat = lstatSync(path);
    visit(path, relPath, stat);
    if (stat.isDirectory()) walk(path, visit, relPath);
  }
}

/** `module` must be a file in the toolchain and every `dirs` value a folder. */
function assertLayout(root: string, wasi: Pick<WasiSpec, "module" | "dirs">): void {
  if (!lstatSync(join(root, wasi.module), { throwIfNoEntry: false })?.isFile()) {
    throw new CodemmError(`wasi.module "${wasi.module}" isn't a file in the downloaded toolchain. Give its path in the archive.`);
  }
  for (const [at, folder] of Object.entries(wasi.dirs)) {
    if (!lstatSync(join(root, folder), { throwIfNoEntry: false })?.isDirectory()) {
      throw new CodemmError(`wasi.dirs "${at}" names "${folder}", which isn't a folder in the downloaded toolchain. Give its path in the archive.`);
    }
  }
}

/** Files 0444 and folders 0555, deepest first, so nothing in a stored toolchain can be changed. */
function seal(root: string): void {
  const dirs: string[] = [];
  walk(root, (path, _rel, stat) => (stat.isDirectory() ? dirs.push(path) : chmodSync(path, 0o444)));
  for (const d of [...dirs.reverse(), root]) chmodSync(d, 0o555);
}

/** Removes a folder that may be read-only, as a stored toolchain is. */
export function removeTree(dir: string): void {
  const writable = (d: string) => {
    try {
      chmodSync(d, 0o700);
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, entry.name);
        if (entry.isDirectory()) writable(path);
        else if (entry.isFile()) chmodSync(path, 0o600);
      }
    } catch {
      // Gone already, or not ours: rmSync reports what matters.
    }
  };
  if (!existsSync(dir)) return;
  writable(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

