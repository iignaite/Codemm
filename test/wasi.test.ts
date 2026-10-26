import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunFolder, stageRunFolder } from "../src/runs.js";
import { readOnly, startWasi, type WasiStart, wasiArgs } from "../src/wasi.js";
import { tempDir } from "./temp.js";
import { fixture, wasmtimeUp } from "./wasi-engine.js";

/** The WASI engine (DESIGN §4.5): the only place Codemm starts wasmtime. */

describe("wasiArgs", () => {
  const args = wasiArgs({
    toolchain: { root: "/t", module: "bin/python.wasm", dirs: { "/lib": "lib", "/usr/share": "share/data" }, env: { PYTHONHOME: "/", EMPTY: "" } },
    src: "/runs/1-abc/src",
    run: "/work/src/main.py  --flag",
    memoryMb: 256,
    timeMs: 2000,
  });
  const joined = args.join(" ");

  it("starts with `run`", () => expect(args[0]).toBe("run"));

  it.each([
    "-W max-memory-size=268435456",
    "-W timeout=2000ms",
    "-S inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n",
    "-C cache=y",
  ])("always includes %s", (flag) => expect(joined).toContain(flag));

  it("maps the learner's files at /work/src and each toolchain folder at its sandbox path, nothing else", () => {
    const dirs = args.flatMap((a, i) => (args[i - 1] === "--dir" ? [a] : []));
    expect(dirs).toEqual(["/runs/1-abc/src::/work/src", `${join("/t", "lib")}::/lib`, `${join("/t", "share/data")}::/usr/share`]);
  });

  it("passes only the toolchain's environment, each with its value, so nothing is inherited", () => {
    const env = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
    expect(env).toEqual(["PYTHONHOME=/", "EMPTY="]);
    expect(args).not.toContain("inherit-env");
  });

  it("ends with the module, then the run command split on spaces", () => {
    expect(args.slice(-3)).toEqual([join("/t", "bin/python.wasm"), "/work/src/main.py", "--flag"]);
  });
});

describe("readOnly", () => {
  it("makes every file 0444 and every folder 0555", () => {
    if (process.platform === "win32") return; // Windows has only a read-only attribute, on files.
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "a");
    stageFolder(dir);
    readOnly(dir);
    expect(statSync(join(dir, "a.txt")).mode & 0o777).toBe(0o444);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, "sub", "b.txt")).mode & 0o777).toBe(0o444);
    expect(statSync(dir).mode & 0o777).toBe(0o555);
  });
});

function stageFolder(dir: string) {
  const sub = join(dir, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "b.txt"), "b");
}

describe("startWasi without wasmtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is an infrastructure error that records nothing", () => {
    vi.stubEnv("CODEMM_WASMTIME", join(tempDir(), "no-wasmtime"));
    expect(() => startWasi(start("cat"))).toThrow(expect.objectContaining({ code: "no-wasmtime", kind: "docker" }));
  });
});

const folders: RunFolder[] = [];
afterEach(() => folders.splice(0).forEach((f) => f.remove()));

/** A run of a fixture with a fresh, staged src folder, removed after the test. */
function start(name: string, extra: Partial<WasiStart> = {}): WasiStart {
  const folder = stageRunFolder();
  folders.push(folder);
  const src = join(folder.dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "main.txt"), "learner file");
  return { toolchain: fixture(name), src, run: "/work/src/main.txt", memoryMb: 256, timeMs: 2000, input: Buffer.alloc(0), outputCap: 1 << 20, ...extra };
}

describe.skipIf(!wasmtimeUp)("startWasi", () => {
  it("pipes the input to stdin and returns stdout and the exit code", async () => {
    const r = await startWasi(start("cat", { input: Buffer.from("hello\nworld\n") })).done;
    expect(r).toMatchObject({ exit: 0, flooded: false, timedOut: false });
    expect(r.stdout.toString()).toBe("hello\nworld\n");
  });

  it("returns the program's own exit code and its stderr", async () => {
    const r = await startWasi(start("fail")).done;
    expect(r).toMatchObject({ exit: 3, timedOut: false, stderr: "boom in /work/src/main.txt\n" });
    expect(r.stdout.toString()).toBe("partial\n");
  });

  it("stops a program at its time limit, without wasmtime's own report of the stop", async () => {
    const begun = Date.now();
    const r = await startWasi(start("loop", { timeMs: 300 })).done;
    expect(r.timedOut).toBe(true);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toBe("");
    expect(Date.now() - begun).toBeLessThan(1300 + 2000);
  });

  it("kills a program the engine's timer misses, at the host's limit", async () => {
    const r = await startWasi(start("loop", { timeMs: 60_000, killMs: 300 })).done;
    expect(r.timedOut).toBe(true);
  });

  it("holds the memory limit: the program's allocation fails", async () => {
    const r = await startWasi(start("grow", { memoryMb: 64 })).done;
    expect(r).toMatchObject({ exit: 1, stderr: "no memory\n", timedOut: false });
  });

  it("kills a program that prints past the output cap as a flood", async () => {
    const r = await startWasi(start("flood", { outputCap: 1 << 20 })).done;
    expect(r.flooded).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1 << 20);
  });

  it("keeps only the first 4 KB of stderr", async () => {
    const r = await startWasi(start("noisy")).done;
    expect(r.stderr).toBe("e".repeat(4096));
  });

  it("gives the program no writable path: it can't create, change or delete anything in /work/src", async () => {
    const s = start("write");
    const before = readFileSync(join(s.src, "main.txt"), "utf8");
    const r = await startWasi(s).done;
    const [create, truncate, mkdir, unlink] = r.stdout.toString().split("\n");
    expect([truncate, unlink]).toEqual(["denied", "denied"]);
    expect(readFileSync(join(s.src, "main.txt"), "utf8")).toBe(before);
    // Windows has no read-only folders, so there a program can still add files (a known limitation, DESIGN §4.5).
    if (process.platform === "win32") return;
    expect([create, mkdir]).toEqual(["denied", "denied"]);
    expect(readdirSync(s.src)).toEqual(["main.txt"]);
  });

  it("without an input, keeps stdin open for typed text until `end`", async () => {
    const { input: _, ...rest } = start("cat");
    const run = startWasi(rest);
    expect(run.write("typed\n")).toBe(true);
    run.end();
    const r = await run.done;
    expect(r.stdout.toString()).toBe("typed\n");
    expect(run.write("late\n")).toBe(false);
  });

  it("`kill` stops it", async () => {
    const { input: _, ...rest } = start("cat");
    const run = startWasi({ ...rest, timeMs: 60_000 });
    run.kill();
    const r = await run.done;
    expect(r.timedOut).toBe(false);
    expect(r.exit).not.toBe(0);
  });
});
