import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { CodemmError, infraError, type InfraCode } from "./errors.js";
import type { WasiSpec } from "./schemas.js";
import * as store from "./store.js";
import { sealReadOnly, unseal } from "./wasi.js";

/**
 * A WASI track's toolchain (DESIGN §4.5): downloaded over https, hashed as it arrives, unpacked with the system tar,
 * sealed read-only and stored once per digest under $CODEMM_HOME/toolchains/. A plain CodemmError is the track's
 * problem (gates report it as gate "toolchain"); this computer's network or disk throws with its infrastructure code.
 */

/** `fetch`, or the desktop's (Electron's net.fetch, for the system's proxy and certificates). Redirects come back to be checked. */
export type Fetcher = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

let custom: Fetcher | undefined;
/** Sets the fetch toolchains download with; none restores Node's. The desktop calls this in-process. */
export function setToolchainFetch(fetcher?: Fetcher): void {
  custom = fetcher;
}
const fetcher = (): Fetcher => custom ?? ((url, init) => fetch(url, init));

export const MAX_DOWNLOAD_BYTES = 256 * 1024 ** 2;
/** A download that receives nothing for this long has stalled. */
const STALL_MS = 60_000;
/** The headers-only check while proposing. */
const ANSWER_MS = 15_000;
const UNPACK_TIMEOUT_MS = 600_000;
const MAX_REDIRECTS = 5;
/** Room for the download and what it unpacks to (DESIGN §4.5). */
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const MB = 1024 ** 2;

type Source = Pick<WasiSpec, "url" | "sha256" | "module" | "dirs">;
/** `replace`: download again even when the digest's folder is there, as a rebuild does, and repair it if it changed. */
type Options = { replace?: boolean; stallMs?: number; maxDownload?: number };

/**
 * The toolchain's folder and the digest of its file. A folder already stored for a given sha256 is used as it is; a
 * toolchain without one is always downloaded, since its digest is only known then. A stored folder is replaced only
 * when its files differ from the download's, so an intact one that a check may be running from is never touched.
 */
export async function ensureToolchain(wasi: Source, { replace = false, ...limits }: Options = {}): Promise<{ root: string; sha256: string }> {
  const parent = store.toolchainsDir();
  // First, and so before the free-space check: what crashed installs left may be what fills the disk.
  removeAbandonedInstalls(parent);
  // A folder damaged outside Codemm (its module or a dirs folder gone) is downloaded again, and so repaired.
  if (wasi.sha256 && !replace && existsSync(store.toolchainDir(wasi.sha256)) && laidOut(store.toolchainDir(wasi.sha256), wasi)) {
    return { root: store.toolchainDir(wasi.sha256), sha256: wasi.sha256 };
  }
  store.assertFreeSpace(parent, MIN_FREE_BYTES);
  // Named after this process, so a crash leaves a folder the next install can tell is abandoned.
  const staging = mkdtempSync(join(parent, `.staging-${process.pid}-`));
  const file = `${staging}.download`;
  try {
    const sha256 = await download(wasi.url, file, wasi.sha256, limits);
    if (new URL(wasi.url).pathname.endsWith(".wasm")) renameSync(file, join(staging, wasi.module));
    else await unpack(file, staging);
    assertLayout(staging, wasi);
    // Its root stays writable, so it can be renamed (macOS) and replaced; no dirs value maps it. A seal that fails is
    // the infrastructure error wasi-seal.
    sealReadOnly(staging);
    const root = store.toolchainDir(sha256);
    await store.withLock(store.toolchainLockPath(sha256), async () => {
      if (existsSync(root) && sameFiles(root, staging)) return;
      const aside = existsSync(root) ? join(parent, `.discard-${process.pid}-${randomBytes(4).toString("hex")}`) : undefined;
      if (aside) renameSync(root, aside);
      try {
        renameSync(staging, root);
      } catch (e) {
        // The old folder goes back rather than being lost. With none, a folder stored meanwhile is used as it is.
        if (aside) renameSync(aside, root);
        else if (existsSync(root)) return;
        throw e;
      }
      if (aside) removeTree(aside);
    });
    assertLayout(root, wasi);
    return { root, sha256 };
  } finally {
    rmSync(file, { force: true });
    removeTree(staging);
  }
}

/** Whether the server says the url's file isn't there (404 or 410), from its headers only. Any answer it can't get is false. */
export async function toolchainMissing(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_MS);
  try {
    const response = await answer(url, controller.signal);
    await response.body?.cancel().catch(() => undefined);
    return response.status === 404 || response.status === 410;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- download ----------

/** Downloads `url` into `file`, hashing it as it arrives. Returns its SHA-256, which must be `expected` when one is given. */
async function download(url: string, file: string, expected: string | undefined, { stallMs = STALL_MS, maxDownload = MAX_DOWNLOAD_BYTES }: Options): Promise<string> {
  const controller = new AbortController();
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const tooBig = () => new CodemmError(`The file at ${url} is larger than ${maxDownload / MB} MB, the most Codemm downloads for a toolchain.`);
  alive();
  try {
    const response = await answer(url, controller.signal);
    const refuse = async (e: CodemmError) => {
      await response.body?.cancel().catch(() => undefined);
      return e;
    };
    const retry = "This is not a problem with the track files, so retry with the same files later.";
    if (response.status === 404 || response.status === 410) {
      throw await refuse(new CodemmError(`Downloading wasi.url failed: HTTP ${response.status}, so ${url} isn't there. Check the link.`));
    }
    if (response.status === 429) throw await refuse(infraError(`The download server is limiting requests (HTTP 429), so nothing was installed. ${retry}`, "rate-limit"));
    if (response.status >= 500) throw await refuse(infraError(`The download server failed (HTTP ${response.status}), so nothing was installed. ${retry}`, "offline"));
    if (!response.ok) throw await refuse(new CodemmError(`Downloading wasi.url failed: ${url} answered HTTP ${response.status}. Check the link.`));
    // A toolchain is never a web page: a school filter or a captive portal answered instead of the server.
    if (/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
      throw await refuse(infraError(
        `A web page came back instead of the toolchain: a network filter or a sign-in page may have answered, or wasi.url (${url}) links to a web page ` +
          "rather than the file itself (a release's download link, not its page). Open the link in a browser: if it downloads the file, sign in to " +
          `the network or ask for ${new URL(url).host} to be allowed, then retry with the same files.`,
        "offline",
      ));
    }
    if (Number(response.headers.get("content-length") ?? 0) > maxDownload) throw await refuse(tooBig());
    const hash = createHash("sha256");
    let bytes = 0;
    const out = await open(file, "wx", 0o600).catch(diskError);
    const reader = response.body?.getReader();
    try {
      for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
        const chunk = read.value;
        alive();
        bytes += chunk.byteLength;
        if (bytes > maxDownload) {
          controller.abort();
          throw tooBig();
        }
        hash.update(chunk);
        await out.write(chunk).catch(diskError);
      }
    } finally {
      await out.close();
    }
    const actual = hash.digest("hex");
    if (expected && actual !== expected) {
      throw new CodemmError(`wasi.sha256 is ${expected}, but the file at ${url} has SHA-256 ${actual}. Check the link, and put the SHA-256 of the file it serves in wasi.sha256.`);
    }
    return actual;
  } catch (e) {
    // The disk's errors (diskError) and the track's are already what they are.
    if (e instanceof CodemmError || e instanceof DiskError) throw e;
    throw networkError(e, stalled);
  } finally {
    clearTimeout(timer);
    // Whatever stopped the download, its connection goes too.
    controller.abort();
  }
}

/** The answer for `url` after at most 5 redirects, each to https with no credentials. */
async function answer(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetcher()(current, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.username || next.password) {
      throw new CodemmError(`wasi.url redirects to a link that isn't https with no credentials (${next.protocol}//${next.host}). Use a link that stays on https.`);
    }
    current = next.href;
  }
  throw new CodemmError(`wasi.url redirects more than ${MAX_REDIRECTS} times. Use the file's final link.`);
}

/** Writing the download failed: this computer's disk, never its network. */
class DiskError extends Error {}
function diskError(e: NodeJS.ErrnoException): never {
  // A disk quota, as school computers often have, is a full disk for the learner.
  if (e.code === "ENOSPC" || e.code === "EDQUOT") throw infraError("The disk filled up while downloading the toolchain. Free some space, then retry.", "host-disk");
  throw new DiskError(`Couldn't save the toolchain's download: ${e.message}`);
}

/** Node's fetch names its errors by code, and Electron's net.fetch by message (`net::ERR_…`). */
const CERTIFICATE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET_ISSUER|VERIFY)/i;
/** A connection that timed out or dropped mid-download, including Chromium's truncated-body errors (net.fetch). */
const DROPPED =
  /ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|ERR_TIMED_OUT|ERR_CONNECTION_(RESET|TIMED_OUT|CLOSED|ABORTED)|ERR_CONTENT_LENGTH_MISMATCH|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_HTTP2_PROTOCOL_ERROR|ERR_NETWORK_CHANGED/;

function networkError(e: unknown, stalled: boolean): CodemmError {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const said = [cause?.code, cause?.message, (e as { code?: string }).code, (e as Error).message].filter(Boolean).join(" ");
  const retry = "This is not a problem with the track files, so retry with the same files.";
  const [message, code]: [string, InfraCode] = stalled || DROPPED.test(said)
    ? ["The toolchain's download stalled or dropped: the connection may be slow.", "network-timeout"]
    : CERTIFICATE.test(said)
      ? ["The toolchain's download was refused over its certificate. A VPN, proxy or security software may be intercepting the connection, or this computer's clock may be wrong.", "tls"]
      : [`The toolchain couldn't be downloaded (${said.slice(0, 200)}): this computer may be offline, or a VPN, proxy or firewall may be blocking it.`, "offline"];
  return infraError(`${message} ${retry}`, code);
}

// ---------- unpacking ----------

/** The system's own tar, by absolute path: bsdtar on macOS and Windows, which reads zip too. */
export function systemTar(): string {
  return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
}

/** Unpacks `file` into `dir`, then refuses any link, special file or file with more than one hard link. */
async function unpack(file: string, dir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(systemTar(), ["-xf", file, "-C", dir], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), UNPACK_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't run the system tar (${systemTar()}) to unpack the toolchain: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const said = stderr.trim().split("\n").slice(-3).join("\n");
      if (/no space left|quota exceeded/i.test(said)) return reject(infraError("The disk filled up while unpacking the toolchain. Free some space, then retry.", "host-disk"));
      // Only the timer kills tar: a slow computer, not the track.
      if (signal) return reject(infraError("Unpacking the toolchain took more than 10 minutes. Close other programs, then retry with the same files.", "check-timeout"));
      reject(new CodemmError(`The archive at wasi.url didn't unpack with this computer's tar${said ? `:\n${said}` : "."}`));
    });
  });
  walk(dir, (_path, rel, stat) => {
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) {
      throw new CodemmError(`The archive at wasi.url holds a link or special file (${rel}). A toolchain may hold only files and folders.`);
    }
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

const laidOut = (root: string, wasi: Pick<WasiSpec, "module" | "dirs">) => {
  try {
    assertLayout(root, wasi);
    return true;
  } catch {
    return false;
  }
};

/** Whether two folders hold the same files with the same contents. */
function sameFiles(a: string, b: string): boolean {
  const list = (dir: string) => {
    const entries: [string, Stats][] = [];
    walk(dir, (_path, rel, stat) => entries.push([rel, stat]));
    return entries;
  };
  const [x, y] = [list(a), list(b)];
  return x.length === y.length && x.every(([rel, stat], i) => {
    const [otherRel, other] = y[i]!;
    if (rel !== otherRel || stat.isDirectory() !== other.isDirectory()) return false;
    return stat.isDirectory() || (stat.size === other.size && readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))));
  });
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

/** Removes a folder whose contents may be sealed, as a stored toolchain's are. */
export function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    unseal(dir);
  } catch {
    // Not sealed, or partly gone: rmSync reports what matters.
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * What an install names its temp entries, after its process: `.staging-<pid>-` and mkdtemp's six letters or digits, its
 * `.download`, and `.discard-<pid>-<eight hex digits>`. Nothing else in toolchains/ is the sweep's to remove.
 */
const LEFTOVER = /^\.(?:staging-(\d+)-[A-Za-z0-9]{6}(?:\.download)?|discard-(\d+)-[0-9a-f]{8})$/;

/**
 * Removes the temp folders and downloads of installs whose Codemm process is gone, as run folders are (runs.ts). Their
 * contents may be sealed, so removeTree unseals them first. A live process's entries, links and anything else here are
 * never touched. Best effort: what can't be removed now is tried again by the next install.
 */
function removeAbandonedInstalls(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const match = LEFTOVER.exec(name);
    const owner = match?.[1] ?? match?.[2];
    if (owner === undefined || store.processAlive(Number(owner))) continue;
    try {
      // Never through a link: unsealing would change whatever it points at.
      if (!lstatSync(join(parent, name)).isSymbolicLink()) removeTree(join(parent, name));
    } catch {
      // Tried again by the next install.
    }
  }
}
