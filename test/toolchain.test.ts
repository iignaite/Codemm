import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodemmError } from "../src/errors.js";
import * as store from "../src/store.js";
import { ensureToolchain, type Fetcher, setToolchainFetch, systemTar, toolchainMissing, unpacker } from "../src/toolchain.js";
import { sealReadOnly, unseal } from "../src/wasi.js";
import { posix } from "./fake-docker.js";
import { tempDir } from "./temp.js";
import { removeHome, removeToolchains } from "./toolchains.js";

let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  vi.stubEnv("CODEMM_HOME", home);
});
afterEach(() => {
  // Stored toolchains are read-only, so the temp folder's own cleanup couldn't remove them.
  removeHome(home);
  vi.unstubAllEnvs();
  setToolchainFetch();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** A PID that belonged to a Codemm process that has since exited. */
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());

/** A .tar.gz of a folder holding `files`, plus whatever `extra` adds to it. */
function archive(files: Record<string, string>, extra?: (dir: string) => void): Uint8Array<ArrayBuffer> {
  const src = tempDir("codemm-archive-src-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  extra?.(src);
  const out = join(tempDir("codemm-archive-"), "a.tar.gz");
  const made = spawnSync(systemTar(), ["-czf", out, "-C", src, "."]);
  if (made.status !== 0) throw new Error(made.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

/**
 * A zip of `files`, stored uncompressed. Written here, since Linux's tar (GNU tar) can't make one. `encrypted` only
 * flags each entry as encrypted, which is enough for a tool to want a password before it reads one.
 */
function zip(files: Record<string, string>, encrypted = false): Uint8Array<ArrayBuffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(encrypted ? 1 : 0, 6);
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    // The central directory's entry repeats the local header's fields, then adds where that header is.
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    local.push(head, name, data);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(central.reduce((n, b) => n + b.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, ...central, end]));
}

const TOOLCHAIN = { "python.wasm": "\0asm fake module", "lib/python3/os.py": "# os\n", "lib/python3/re.py": "# re\n" };

/** Serves `routes` by URL as the toolchain's fetch, and counts the requests. */
function serve(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  setToolchainFetch(fetcher);
  return calls;
}
const fails = (cause: { code: string; message: string }): Fetcher => async () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error(cause.message), { code: cause.code }) });
};

const URL_TGZ = "https://example.org/python.tar.gz";
const spec = (body: Uint8Array, url = URL_TGZ) => ({ url, sha256: sha(body), module: "python.wasm", dirs: { "/lib": "lib" } });
/** Every entry under toolchains/, including leftovers that start with a dot. */
const stored = () => (existsSync(store.toolchainsDir()) ? readdirSync(store.toolchainsDir()).sort() : []);

describe("ensureToolchain", () => {
  it("downloads, checks and unpacks an archive into its digest's folder, sealing everything under it", async () => {
    const body = archive(TOOLCHAIN);
    serve({ [URL_TGZ]: () => new Response(body) });
    const { root, sha256 } = await ensureToolchain(spec(body));
    expect(sha256).toBe(sha(body));
    expect(root).toBe(store.toolchainDir(sha(body)));
    expect(readFileSync(join(root, "python.wasm"), "utf8")).toBe(TOOLCHAIN["python.wasm"]);
    expect(readFileSync(join(root, "lib", "python3", "os.py"), "utf8")).toBe("# os\n");
    expect(stored().filter((n) => !n.startsWith(".") || !n.endsWith(".lock"))).toEqual([sha(body)]);
    if (posix) {
      expect(statSync(join(root, "python.wasm")).mode & 0o777).toBe(0o444);
      expect(statSync(join(root, "lib", "python3")).mode & 0o777).toBe(0o555);
      // The root stays writable, so a damaged folder can be replaced; no dirs value maps it.
      expect(statSync(root).mode & 0o200).toBe(0o200);
    }
  });

  it("stores a .wasm as it is, under its own name", async () => {
    const body = new TextEncoder().encode("\0asm a module");
    const url = "https://example.org/dl/run.wasm";
    serve({ [url]: () => new Response(body) });
    const { root } = await ensureToolchain({ url, sha256: sha(body), module: "run.wasm", dirs: {} });
    expect(readdirSync(root)).toEqual(["run.wasm"]);
    expect(new Uint8Array(readFileSync(join(root, "run.wasm")))).toEqual(body);
  });

  // CI requires the WASI engine's tools, so a Linux runner without bsdtar or unzip fails here rather than skipping.
  it.runIf(unzips() || process.env.CODEMM_REQUIRE_WASMTIME === "1")("unpacks a zip, on Linux too", async () => {
    const body = zip(TOOLCHAIN);
    const url = "https://example.org/python.zip";
    serve({ [url]: () => new Response(body) });
    const { root } = await ensureToolchain(spec(body, url));
    expect(readFileSync(join(root, "lib", "python3", "re.py"), "utf8")).toBe("# re\n");
  });

  it.runIf(unzips())("refuses an encrypted zip as the track's problem, without waiting at the terminal for a password", async () => {
    const body = zip(TOOLCHAIN, true);
    const url = "https://example.org/python.zip";
    serve({ [url]: () => new Response(body) });
    const install = ensureToolchain(spec(body, url));
    await expect(install).rejects.toThrow(/didn't unpack/);
    await expect(install).rejects.toSatisfy((e: CodemmError) => e.code === undefined);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  }, 20_000);

  it("reuses a folder already stored for that digest, without downloading", async () => {
    const body = archive(TOOLCHAIN);
    const calls = serve({ [URL_TGZ]: () => new Response(body) });
    await ensureToolchain(spec(body));
    await ensureToolchain(spec(body));
    expect(calls).toHaveLength(1);
  });

  it("without a sha256, stores the file under the digest it downloaded", async () => {
    const body = archive(TOOLCHAIN);
    const calls = serve({ [URL_TGZ]: () => new Response(body) });
    const { sha256: _given, ...unpinned } = spec(body);
    expect(await ensureToolchain(unpinned)).toEqual({ root: store.toolchainDir(sha(body)), sha256: sha(body) });
    // Its digest can't be known before downloading, so it downloads again, and the folder already there is used.
    expect(await ensureToolchain(unpinned)).toEqual({ root: store.toolchainDir(sha(body)), sha256: sha(body) });
    expect(calls).toHaveLength(2);
  });

  it("repairs a stored folder damaged outside Codemm by downloading it again", async () => {
    const body = archive(TOOLCHAIN);
    const calls = serve({ [URL_TGZ]: () => new Response(body) });
    const { root } = await ensureToolchain(spec(body));
    unseal(root);
    rmSync(join(root, "lib"), { recursive: true });
    await ensureToolchain(spec(body));
    expect(readFileSync(join(root, "lib", "python3", "os.py"), "utf8")).toBe("# os\n");
    expect(calls).toHaveLength(2);
    expect(stored().filter((n) => n.startsWith(".") && !n.endsWith(".lock"))).toEqual([]);
  });

  it("on a rebuild, replaces a folder whose files changed, and keeps an intact one, which a check may be using", async () => {
    const body = archive(TOOLCHAIN);
    const calls = serve({ [URL_TGZ]: () => new Response(body) });
    const { root } = await ensureToolchain(spec(body));
    const before = statSync(root).ino;
    await ensureToolchain(spec(body), { replace: true });
    expect(statSync(root).ino).toBe(before);
    unseal(root);
    writeFileSync(join(root, "lib", "python3", "os.py"), "# changed\n");
    await ensureToolchain(spec(body), { replace: true });
    expect(readFileSync(join(root, "lib", "python3", "os.py"), "utf8")).toBe("# os\n");
    expect(calls).toHaveLength(3);
    expect(stored().filter((n) => n.startsWith(".") && !n.endsWith(".lock"))).toEqual([]);
  });

  it("refuses a file whose SHA-256 doesn't match, naming both digests, before unpacking it", async () => {
    const body = archive(TOOLCHAIN);
    const wrong = "0".repeat(64);
    serve({ [URL_TGZ]: () => new Response(body) });
    const install = ensureToolchain({ ...spec(body), sha256: wrong });
    await expect(install).rejects.toThrow(new RegExp(`${wrong}[\\s\\S]*${sha(body)}`));
    await expect(install).rejects.toSatisfy((e: CodemmError) => e.code === undefined);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  it.runIf(posix)("refuses an archive holding a link or a hard-linked file, and stores nothing", async () => {
    const soft = archive(TOOLCHAIN, (dir) => symlinkSync("/etc", join(dir, "lib", "etc")));
    serve({ [URL_TGZ]: () => new Response(soft) });
    await expect(ensureToolchain(spec(soft))).rejects.toThrow(/link or special file \(lib\/etc\)/);
    const hard = archive(TOOLCHAIN, (dir) => linkSync(join(dir, "lib", "python3", "os.py"), join(dir, "lib", "os2.py")));
    serve({ [URL_TGZ]: () => new Response(hard) });
    await expect(ensureToolchain(spec(hard))).rejects.toThrow(/link or special file/);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  it("refuses a download over the size limit, whether declared or streamed", async () => {
    // Random bytes, so gzip can't shrink the archive under the limit.
    const body = archive({ ...TOOLCHAIN, "lib/big.bin": randomBytes(50_000).toString("base64") });
    serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain(spec(body), { maxDownload: 1000 })).rejects.toThrow(/larger than/);
    setToolchainFetch(async () => new Response(new Blob([body]).stream()));
    await expect(ensureToolchain(spec(body), { maxDownload: 1000 })).rejects.toThrow(/larger than/);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  it("refuses an archive without the module or a dirs folder", async () => {
    const body = archive(TOOLCHAIN);
    serve({ [URL_TGZ]: () => new Response(body) });
    await expect(ensureToolchain({ ...spec(body), module: "bin/python.wasm" })).rejects.toThrow(/wasi.module "bin\/python.wasm"/);
    await expect(ensureToolchain({ ...spec(body), dirs: { "/lib": "lib/python3.15" } })).rejects.toThrow(/wasi.dirs "\/lib"/);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  it("follows https redirects, and refuses one to http", async () => {
    const body = archive(TOOLCHAIN);
    const moved = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const calls = serve({ [URL_TGZ]: moved("/cdn/python.tar.gz"), "https://example.org/cdn/python.tar.gz": () => new Response(body) });
    await ensureToolchain(spec(body));
    expect(calls).toEqual([URL_TGZ, "https://example.org/cdn/python.tar.gz"]);
    removeToolchains();
    serve({ [URL_TGZ]: moved("http://example.org/python.tar.gz") });
    await expect(ensureToolchain(spec(body))).rejects.toThrow(/redirects to a link that isn't https/);
  });

  it("calls a missing file the track's problem, naming the url", async () => {
    const body = archive(TOOLCHAIN);
    for (const status of [404, 410]) {
      serve({ [URL_TGZ]: () => new Response("", { status }) });
      const missing = ensureToolchain(spec(body));
      await expect(missing).rejects.toThrow(new RegExp(`HTTP ${status}[\\s\\S]*${URL_TGZ}`));
      await expect(missing).rejects.toSatisfy((e: CodemmError) => e.code === undefined);
    }
  });

  it("calls a filter's page, a busy server, an unknown name or a certificate problem this computer's", async () => {
    const body = archive(TOOLCHAIN);
    serve({ [URL_TGZ]: () => new Response("<html>Blocked</html>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "offline", message: expect.stringMatching(/network filter[\s\S]*web page/) });
    serve({ [URL_TGZ]: () => new Response("", { status: 503 }) });
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "offline", kind: "offline" });
    serve({ [URL_TGZ]: () => new Response("", { status: 429 }) });
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "rate-limit" });
    setToolchainFetch(fails({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.org" }));
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "offline" });
    setToolchainFetch(fails({ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" }));
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "tls" });
    setToolchainFetch(fails({ code: "CERT_HAS_EXPIRED", message: "certificate has expired" }));
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "tls" });
    // Electron's net.fetch, as the desktop passes it, names its errors this way.
    setToolchainFetch(async () => {
      throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
    });
    await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "tls" });
  });

  it.each(["ERR_CONTENT_LENGTH_MISMATCH", "ERR_INCOMPLETE_CHUNKED_ENCODING", "ERR_HTTP2_PROTOCOL_ERROR", "ERR_NETWORK_CHANGED", "ERR_CONNECTION_ABORTED"])(
    "calls Electron's net::%s mid-download a dropped connection",
    async (code) => {
      const body = archive(TOOLCHAIN);
      const cut = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, 10));
          controller.error(new Error(`net::${code}`));
        },
      });
      setToolchainFetch(async () => new Response(cut));
      await expect(ensureToolchain(spec(body))).rejects.toMatchObject({ code: "network-timeout" });
    },
  );

  it("stops a stalled download, as this computer's network", async () => {
    const body = archive(TOOLCHAIN);
    setToolchainFetch((_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await expect(ensureToolchain(spec(body), { stallMs: 50 })).rejects.toMatchObject({ code: "network-timeout" });
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  it("first removes what crashed installs left, sealed or not, and never a live install's, a link or anything else", async () => {
    const body = archive(TOOLCHAIN);
    const calls = serve({ [URL_TGZ]: () => new Response(body) });
    await ensureToolchain(spec(body));
    const parent = store.toolchainsDir();
    /** A temp folder as an install leaves it: its contents sealed. */
    const leftover = (name: string) => {
      mkdirSync(join(parent, name, "lib"), { recursive: true });
      writeFileSync(join(parent, name, "lib", "os.py"), "# os\n");
      sealReadOnly(join(parent, name));
      return name;
    };
    const dead = deadPid();
    leftover(`.staging-${dead}-AbC123`);
    writeFileSync(join(parent, `.staging-${dead}-AbC123.download`), "partial");
    leftover(`.discard-${dead}-0a1b2c3d`);
    const live = leftover(`.staging-${process.pid}-dEf456`);
    // Not named after its owner: an older Codemm's, or not Codemm's.
    const unowned = leftover(".staging-XyZ789");
    // A sealed folder outside toolchains/, linked under a leftover's name (a junction on Windows, which needs no admin rights).
    const elsewhere = tempDir();
    mkdirSync(join(elsewhere, "sealed"));
    sealReadOnly(elsewhere);
    const link = `.staging-${dead}-L1nk00`;
    symlinkSync(elsewhere, join(parent, link), "junction");
    // Even an install that downloads nothing, since the digest's folder is there.
    await ensureToolchain(spec(body));
    expect(calls).toHaveLength(1);
    expect(stored().filter((n) => !n.endsWith(".lock"))).toEqual([live, unowned, link, sha(body)].sort());
    // The link was never followed, so what it points at is still sealed.
    expect(() => writeFileSync(join(elsewhere, "sealed", "new.txt"), "x")).toThrow();
    unseal(elsewhere);
  });
});

describe("toolchainMissing", () => {
  it("is true only when the server says the file isn't there", async () => {
    serve({ "https://example.org/a.zip": () => new Response("x"), "https://example.org/gone.zip": () => new Response("", { status: 410 }) });
    expect(await toolchainMissing("https://example.org/a.zip")).toBe(false);
    expect(await toolchainMissing("https://example.org/gone.zip")).toBe(true);
    expect(await toolchainMissing("https://example.org/b.zip")).toBe(true);
    setToolchainFetch(fails({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.org" }));
    expect(await toolchainMissing("https://example.org/a.zip")).toBe(false);
  });
});

describe("unpacker", () => {
  const only = (bin: string) => (path: string) => path === bin;

  it("unpacks with the system tar, which reads zip too on macOS and Windows", () => {
    expect(unpacker("a.download", "out", false, "linux", () => false)).toEqual(["/usr/bin/tar", ["-xf", "a.download", "-C", "out"]]);
    expect(unpacker("a.download", "out", true, "darwin", () => false)).toEqual(["/usr/bin/tar", ["-xf", "a.download", "-C", "out"]]);
    expect(unpacker("a.download", "out", true, "win32", () => false)).toEqual([systemTar("win32"), ["-xf", "a.download", "-C", "out"]]);
    expect(systemTar("win32")).toMatch(/System32[\\/]tar\.exe$/);
  });

  it("unpacks a zip on Linux, whose GNU tar can't read one, with bsdtar, else unzip, by absolute path", () => {
    expect(unpacker("a.download", "out", true, "linux", () => true)).toEqual(["/usr/bin/bsdtar", ["-xf", "a.download", "-C", "out"]]);
    expect(unpacker("a.download", "out", true, "linux", only("/usr/bin/unzip"))).toEqual(["/usr/bin/unzip", ["-qq", "-o", "a.download", "-d", "out"]]);
  });

  it("with neither on Linux, fails the toolchain gate, saying what to install", () => {
    const neither = () => unpacker("a.download", "out", true, "linux", () => false);
    expect(neither).toThrow(/install unzip[\s\S]*\.tar\.gz/i);
    // Gate "toolchain" (no infrastructure code): a .tar.gz link avoids it.
    expect(neither).toThrow(expect.objectContaining({ code: undefined }));
  });

  it.runIf(existsSync("/usr/bin/unzip"))("unzip's arguments unpack a zip into the folder", () => {
    const file = join(tempDir(), "a.download");
    writeFileSync(file, zip(TOOLCHAIN));
    const dir = tempDir();
    const [bin, args] = unpacker(file, dir, true, "linux", only("/usr/bin/unzip"));
    expect(spawnSync(bin, args, { encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(join(dir, "lib", "python3", "re.py"), "utf8")).toBe("# re\n");
  });
});

/** Whether this computer can unpack a zip: always on macOS and Windows; on Linux, with bsdtar or unzip installed. */
function unzips(): boolean {
  try {
    unpacker("a.download", "out", true);
    return true;
  } catch {
    return false;
  }
}
