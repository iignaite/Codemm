import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodemmError } from "../src/errors.js";
import * as store from "../src/store.js";
import { ensureToolchain, type Fetcher, removeTree, systemTar } from "../src/toolchain.js";
import { posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";

let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_HOME", home);
});
afterEach(() => {
  // Stored toolchains are read-only, so the temp folder's own cleanup couldn't remove them.
  removeTree(home);
  vi.unstubAllEnvs();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A .tar.gz (or, with bsdtar, a .zip) of a folder holding `files`, plus whatever `extra` adds to it. */
function archive(files: Record<string, string>, format: "tar.gz" | "zip" = "tar.gz", extra?: (dir: string) => void): Uint8Array<ArrayBuffer> {
  const src = tempDir("codemm-archive-src-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  extra?.(src);
  const out = join(tempDir("codemm-archive-"), `a.${format}`);
  const args = format === "zip" ? ["--format", "zip", "-cf", out, "-C", src, "."] : ["-czf", out, "-C", src, "."];
  const made = spawnSync(systemTar(), args);
  if (made.status !== 0) throw new Error(made.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

const TOOLCHAIN = { "python.wasm": "\0asm fake module", "lib/python3/os.py": "# os\n", "lib/python3/re.py": "# re\n" };

/** Serves `routes` by URL, and counts the requests. */
function serve(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

const URL_TGZ = "https://example.org/python.tar.gz";
const spec = (body: Uint8Array, url = URL_TGZ) => ({ url, sha256: sha(body), module: "python.wasm", dirs: { "/lib": "lib" } });
/** Every entry under toolchains/, including leftovers that start with a dot. */
const stored = () => (existsSync(store.toolchainsDir()) ? readdirSync(store.toolchainsDir()).sort() : []);

describe("ensureToolchain", () => {
  it("downloads, checks and unpacks an archive into its digest's folder, read-only", async () => {
    const body = archive(TOOLCHAIN);
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    const root = await ensureToolchain(spec(body), { fetcher });
    expect(root).toBe(store.toolchainDir(sha(body)));
    expect(readFileSync(join(root, "python.wasm"), "utf8")).toBe(TOOLCHAIN["python.wasm"]);
    expect(readFileSync(join(root, "lib", "python3", "os.py"), "utf8")).toBe("# os\n");
    expect(stored()).toEqual([sha(body)]);
    if (posix) {
      expect(statSync(join(root, "python.wasm")).mode & 0o777).toBe(0o444);
      expect(statSync(join(root, "lib", "python3")).mode & 0o777).toBe(0o555);
      expect(statSync(root).mode & 0o777).toBe(0o555);
    }
  });

  it("stores a .wasm as it is, under its own name", async () => {
    const body = new TextEncoder().encode("\0asm a module");
    const url = "https://example.org/dl/run.wasm";
    const { fetcher } = serve({ [url]: () => new Response(body) });
    const root = await ensureToolchain({ url, sha256: sha(body), module: "run.wasm", dirs: {} }, { fetcher });
    expect(readdirSync(root)).toEqual(["run.wasm"]);
    expect(new Uint8Array(readFileSync(join(root, "run.wasm")))).toEqual(body);
  });

  it.runIf(systemTarReadsZip())("unpacks a zip with the system tar", async () => {
    const body = archive(TOOLCHAIN, "zip");
    const url = "https://example.org/python.zip";
    const { fetcher } = serve({ [url]: () => new Response(body) });
    const root = await ensureToolchain(spec(body, url), { fetcher });
    expect(readFileSync(join(root, "lib", "python3", "re.py"), "utf8")).toBe("# re\n");
  });

  it("reuses a folder already stored for that digest, without downloading", async () => {
    const body = archive(TOOLCHAIN);
    const { fetcher, calls } = serve({ [URL_TGZ]: () => new Response(body) });
    await ensureToolchain(spec(body), { fetcher });
    await ensureToolchain(spec(body), { fetcher });
    expect(calls).toHaveLength(1);
  });

  it("refuses a file whose SHA-256 doesn't match, naming both digests, before unpacking it", async () => {
    const body = archive(TOOLCHAIN);
    const wrong = "0".repeat(64);
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    const install = ensureToolchain({ ...spec(body), sha256: wrong }, { fetcher });
    await expect(install).rejects.toThrow(new RegExp(`${wrong}[\\s\\S]*${sha(body)}`));
    await expect(install).rejects.toSatisfy((e: CodemmError) => e.code === undefined);
    expect(stored()).toEqual([]);
  });

  it.runIf(posix)("refuses an archive holding a link, and stores nothing", async () => {
    const body = archive(TOOLCHAIN, "tar.gz", (dir) => symlinkSync("/etc", join(dir, "lib", "etc")));
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain(spec(body), { fetcher })).rejects.toThrow(/link or special file \(lib\/etc\)/);
    expect(stored()).toEqual([]);
  });

  it("refuses a download over the size limit, whether declared or streamed", async () => {
    const body = archive({ ...TOOLCHAIN, "lib/big.bin": "x".repeat(50_000) });
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain(spec(body), { fetcher, maxDownload: 1000 })).rejects.toThrow(/larger than/);
    const streamed: Fetcher = async () => new Response(new Blob([body]).stream());
    await expect(ensureToolchain(spec(body), { fetcher: streamed, maxDownload: 1000 })).rejects.toThrow(/larger than/);
    expect(stored()).toEqual([]);
  });

  it("refuses an archive that unpacks to more than the limit", async () => {
    const body = archive({ ...TOOLCHAIN, "lib/zeros.bin": "\0".repeat(200_000) });
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain(spec(body), { fetcher, maxUnpacked: 100_000 })).rejects.toThrow(/unpacks to more than/);
    expect(stored()).toEqual([]);
  });

  it("refuses an archive without the module or a dirs folder", async () => {
    const body = archive(TOOLCHAIN);
    const { fetcher } = serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain({ ...spec(body), module: "bin/python.wasm" }, { fetcher })).rejects.toThrow(/wasi.module "bin\/python.wasm"/);
    await expect(ensureToolchain({ ...spec(body), dirs: { "/lib": "lib/python3.15" } }, { fetcher })).rejects.toThrow(/wasi.dirs "\/lib"/);
    expect(stored()).toEqual([]);
  });

  it("follows https redirects, and refuses one to http", async () => {
    const body = archive(TOOLCHAIN);
    const moved = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const ok = serve({ [URL_TGZ]: moved("/cdn/python.tar.gz"), "https://example.org/cdn/python.tar.gz": () => new Response(body) });
    await ensureToolchain(spec(body), { fetcher: ok.fetcher });
    expect(ok.calls).toEqual([URL_TGZ, "https://example.org/cdn/python.tar.gz"]);
    removeTree(store.toolchainsDir());
    const insecure = serve({ [URL_TGZ]: moved("http://example.org/python.tar.gz") });
    await expect(ensureToolchain(spec(body), { fetcher: insecure.fetcher })).rejects.toThrow(/redirects to a link that isn't https/);
  });

  it("calls a missing file the track's problem, and a busy or unreachable server this computer's", async () => {
    const body = archive(TOOLCHAIN);
    const missing = ensureToolchain(spec(body), serve({}));
    await expect(missing).rejects.toThrow(/HTTP 404/);
    await expect(missing).rejects.toSatisfy((e: CodemmError) => e.code === undefined);
    const answer = (status: number) => serve({ [URL_TGZ]: () => new Response("", { status }) });
    await expect(ensureToolchain(spec(body), answer(503))).rejects.toMatchObject({ code: "offline", kind: "offline" });
    await expect(ensureToolchain(spec(body), answer(429))).rejects.toMatchObject({ code: "rate-limit" });
    const unreachable: Fetcher = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.org"), { code: "ENOTFOUND" }) });
    };
    await expect(ensureToolchain(spec(body), { fetcher: unreachable })).rejects.toMatchObject({ code: "offline" });
    const intercepted: Fetcher = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }) });
    };
    await expect(ensureToolchain(spec(body), { fetcher: intercepted })).rejects.toMatchObject({ code: "tls" });
  });

  it("stops a download that takes too long, as this computer's network", async () => {
    const body = archive(TOOLCHAIN);
    const stalls: Fetcher = (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    await expect(ensureToolchain(spec(body), { fetcher: stalls, timeoutMs: 50 })).rejects.toMatchObject({ code: "network-timeout" });
    expect(stored()).toEqual([]);
  });
});

function systemTarReadsZip(): boolean {
  return /bsdtar/.test(spawnSync(systemTar(), ["--version"]).stdout?.toString() ?? "");
}
