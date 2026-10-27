import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunFolder, stageRunFolder } from "../src/runs.js";
import { compiledPath, prepareWasi, removeSealed, sealReadOnly, startWasi, unseal, type WasiStart, wasiArgs, wasmtime } from "../src/wasi.js";
import { tempDir } from "./temp.js";
import { fixture, wasmtimeUp } from "./wasi-engine.js";

/** The WASI engine (DESIGN §4.5): the only place Codemm starts wasmtime. */

afterEach(() => vi.unstubAllEnvs());
const posix = process.platform !== "win32";

describe("wasiArgs", () => {
  const args = wasiArgs({
    engine: { bin: "/bin/wasmtime", compiled: "/home/toolchains/compiled/abc-50.0.0.cwasm" },
    toolchain: { root: "/t", sha256: "abc", module: "bin/python.wasm", dirs: { "/lib": "lib", "/usr/share": "share/data" }, env: { PYTHONHOME: "/", EMPTY: "" } },
    src: "/runs/1-abc/src",
    run: "/work/src/main.py  --flag",
    memoryMb: 256,
    timeMs: 2000,
  });
  const joined = args.join(" ");

  it("starts with `run`", () => expect(args[0]).toBe("run"));

  it.each([
    "--allow-precompiled -C cache=n",
    "-W max-memory-size=268435456",
    "-W timeout=2000ms",
    "-W max-memories=1,max-tables=8,max-table-elements=1000000,max-instances=4",
    "-S inherit-network=n,tcp=n,udp=n,allow-ip-name-lookup=n,http=n",
  ])("always includes %s", (flag) => expect(joined).toContain(flag));

  it("maps the learner's files at /work/src and each toolchain folder at its sandbox path, nothing else", () => {
    const dirs = args.flatMap((a, i) => (args[i - 1] === "--dir" ? [a] : []));
    expect(dirs).toEqual(["/runs/1-abc/src::/work/src", `${join("/t", "lib")}::/lib`, `${join("/t", "share/data")}::/usr/share`]);
  });

  it("passes only the toolchain's environment, each with its value, so nothing is inherited", () => {
    const env = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
    expect(env).toEqual(["PYTHONHOME=/", "EMPTY="]);
    expect(joined).not.toContain("inherit-env");
  });

  it("runs the compiled module, never the toolchain's own, then the run command split on spaces", () => {
    expect(args.slice(-3)).toEqual(["/home/toolchains/compiled/abc-50.0.0.cwasm", "/work/src/main.py", "--flag"]);
  });
});

describe("sealReadOnly and unseal", () => {
  const tree = () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "pkg", "b.txt"), "b");
    writeFileSync(join(dir, "top.txt"), "t");
    return dir;
  };

  it.runIf(posix)("seals everything under a folder (files 0444, folders 0555) but not the folder itself", () => {
    const dir = tree();
    sealReadOnly(dir);
    const mode = (p: string) => statSync(join(dir, p)).mode & 0o777;
    expect([mode("top.txt"), mode("src"), mode("src/pkg"), mode("src/pkg/b.txt")]).toEqual([0o444, 0o555, 0o555, 0o444]);
    expect(statSync(dir).mode & 0o200).toBe(0o200);
    unseal(dir);
  });

  it("can be undone, so a sealed folder can be changed and removed", () => {
    const dir = tree();
    const begun = Date.now();
    sealReadOnly(dir);
    unseal(dir);
    // On Windows each is one icacls run per top-level folder; the CI log shows what it costs.
    console.log(`seal and unseal one folder: ${Date.now() - begun} ms`);
    writeFileSync(join(dir, "src", "pkg", "new.txt"), "writable again");
  });

  it("fails as the infrastructure error wasi-seal, which records nothing", () => {
    expect(() => sealReadOnly(join(tempDir(), "missing"))).toThrow(expect.objectContaining({ code: "wasi-seal", kind: "disk" }));
  });
});

describe("the checks before a set", () => {
  it("need wasmtime: without it, the infrastructure error that records nothing", () => {
    vi.stubEnv("CODEMM_WASMTIME", join(tempDir(), "no-wasmtime"));
    expect(() => wasmtime()).toThrow(expect.objectContaining({ code: "no-wasmtime", kind: "docker" }));
  });

  it.runIf(posix)("need wasmtime 50, not another version", () => {
    const fake = join(tempDir(), "wasmtime");
    writeFileSync(fake, "#!/bin/sh\necho 'wasmtime 49.0.1 (abc 2026-01-01)'\n", { mode: 0o755 });
    vi.stubEnv("CODEMM_WASMTIME", fake);
    expect(() => wasmtime()).toThrow(expect.objectContaining({ code: "no-wasmtime", message: expect.stringMatching(/49\.0\.1.*wasmtime 50/) }));
  });

  it.skipIf(!wasmtimeUp)("say a missing toolchain needs a rebuild", async () => {
    await expect(prepareWasi(fixture("cat", { root: join(tempDir(), "gone") }))).rejects.toMatchObject({ kind: "image-missing", message: expect.stringMatching(/Rebuild the track/) });
    await expect(prepareWasi(fixture("cat", { dirs: { "/lib": "no-such-folder" } }))).rejects.toMatchObject({ kind: "image-missing" });
  });

  it.skipIf(!wasmtimeUp)("compile the module once for this wasmtime, outside the toolchain folder", async () => {
    const t = fixture("cat", { sha256: `once-${Date.now()}` });
    const engine = await prepareWasi(t);
    expect(engine.compiled).toBe(compiledPath(t.sha256, wasmtime().version));
    expect(existsSync(engine.compiled)).toBe(true);
    const at = statSync(engine.compiled).mtimeMs;
    await prepareWasi(t);
    expect(statSync(engine.compiled).mtimeMs).toBe(at);
  });

  it.skipIf(!wasmtimeUp)("remove the temp files of compiles whose Codemm process is gone", async () => {
    const t = fixture("cat", { sha256: `sweep-${Date.now()}` });
    const dir = dirname(compiledPath(t.sha256, wasmtime().version));
    mkdirSync(dir, { recursive: true });
    const gone = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
    const leftover = join(dir, `other-50.0.0.cwasm.${gone}-0123abcd.tmp`);
    const live = join(dir, `other-50.0.0.cwasm.${process.pid}-0123abcd.tmp`);
    writeFileSync(leftover, "half a module");
    writeFileSync(live, "still compiling");
    await prepareWasi(t);
    expect([existsSync(leftover), existsSync(live)]).toEqual([false, true]);
  });

  it.skipIf(!wasmtimeUp)("say a module that doesn't compile is the toolchain's fault, not this computer's", async () => {
    const root = tempDir();
    writeFileSync(join(root, "bad.wasm"), "not wasm");
    const err = await prepareWasi({ root, sha256: "bad", module: "bad.wasm", dirs: {}, env: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringMatching(/didn't compile/) });
    expect((err as { code?: string }).code).toBeUndefined();
  });
});

const folders: RunFolder[] = [];
afterEach(() => folders.splice(0).forEach((f) => removeSealed(f)));

/** A run of a fixture: the engine prepared, a fresh run folder with the learner's file, sealed. Removed after the test. */
async function start(name: string, extra: Partial<WasiStart> = {}): Promise<WasiStart> {
  const toolchain = fixture(name);
  const engine = await prepareWasi(toolchain);
  const folder = stageRunFolder();
  folders.push(folder);
  const src = join(folder.dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "main.txt"), "learner file");
  sealReadOnly(folder.dir);
  return { engine, toolchain, src, run: "/work/src/main.txt", memoryMb: 256, timeMs: 2000, input: Buffer.alloc(0), outputCap: 1 << 20, ...extra };
}

describe.skipIf(!wasmtimeUp)("startWasi", () => {
  it("pipes the input to stdin and returns stdout and the exit code", async () => {
    const r = await startWasi(await start("cat", { input: Buffer.from("hello\nworld\n") })).done;
    // First, so a failing start shows wasmtime's own words.
    expect(r.stderr).toBe("");
    expect(r).toMatchObject({ exit: 0, flooded: false, timedOut: false });
    expect(r.stdout.toString()).toBe("hello\nworld\n");
  });

  it("returns the program's own exit code and its stderr", async () => {
    const r = await startWasi(await start("fail")).done;
    expect(r).toMatchObject({ exit: 3, timedOut: false, stderr: "boom in /work/src/main.txt\n" });
    expect(r.stdout.toString()).toBe("partial\n");
  });

  it("stops a program at its time limit, without wasmtime's report of the stop", async () => {
    const begun = Date.now();
    const r = await startWasi(await start("loop", { timeMs: 300 })).done;
    expect(r).toMatchObject({ timedOut: true, stderr: "" });
    expect(r.exit).not.toBe(0);
    expect(Date.now() - begun).toBeLessThan(3000);
  });

  it("kills a program the engine's timer misses, at the host's limit", async () => {
    const r = await startWasi(await start("loop", { timeMs: 60_000, killMs: 300 })).done;
    expect(r).toMatchObject({ timedOut: true, exit: 137 });
  });

  it("counts a program that fails after its time limit passed as timed out", async () => {
    const r = await startWasi(await start("fail", { timeMs: 1, killMs: 60_000 })).done;
    expect(r.timedOut).toBe(true);
  });

  it("holds the memory limit: the program's allocation fails", async () => {
    const r = await startWasi(await start("grow", { memoryMb: 64 })).done;
    expect(r).toMatchObject({ exit: 1, stderr: "no memory\n", timedOut: false });
  });

  it("refuses a module with a second memory, so the memory limit holds for the whole program", async () => {
    const r = await startWasi(await start("memories")).done;
    expect(r.exit).not.toBe(0);
  });

  it("kills a program that prints past the output cap as a flood", async () => {
    const r = await startWasi(await start("flood", { outputCap: 1 << 20 })).done;
    expect(r.flooded).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1 << 20);
  });

  it("keeps only the first 4 KB of stderr and reads the rest to the end", async () => {
    const r = await startWasi(await start("noisy")).done;
    expect(r).toMatchObject({ exit: 1, stderr: "e".repeat(4096), timedOut: false });
  });

  it("gives the program no writable path: it can't create, change or delete anything in /work/src", async () => {
    const s = await start("write");
    const r = await startWasi(s).done;
    // Create new.txt, truncate main.txt, make a folder, delete main.txt.
    expect(r.stdout.toString()).toBe("denied\ndenied\ndenied\ndenied\n");
    expect(readdirSync(s.src)).toEqual(["main.txt"]);
    expect(readFileSync(join(s.src, "main.txt"), "utf8")).toBe("learner file");
  });


  it("lets the program read files in subfolders, and change nothing there", async () => {
    const s = await start("nested");
    // Sealed before the run: unseal to add the subfolder, then seal again.
    const run = dirname(s.src);
    unseal(run);
    mkdirSync(join(s.src, "sub"));
    writeFileSync(join(s.src, "sub", "inner.txt"), "inner\n");
    sealReadOnly(run);
    const r = await startWasi(s).done;
    expect(r.stderr).toBe("");
    expect(r.stdout.toString()).toBe("inner\ndenied\ndenied\n");
    expect(readdirSync(join(s.src, "sub"))).toEqual(["inner.txt"]);
  });

  it("lets the program neither rename a subfolder nor delete one that isn't empty", async () => {
    const s = await start("rename");
    const run = dirname(s.src);
    unseal(run);
    mkdirSync(join(s.src, "sub"));
    writeFileSync(join(s.src, "sub", "inner.txt"), "inner\n");
    mkdirSync(join(s.src, "other"));
    sealReadOnly(run);
    const r = await startWasi(s).done;
    expect(r.stderr).toBe("");
    // Rename sub within /work/src, move it into other/, delete it.
    expect(r.stdout.toString()).toBe("denied\ndenied\ndenied\n");
    expect(readdirSync(s.src).sort()).toEqual(["main.txt", "other", "sub"]);
    expect(readdirSync(join(s.src, "other"))).toEqual([]);
  });

  it.runIf(posix)("starts wasmtime with an empty environment", async () => {
    const fake = join(tempDir(), "wasmtime");
    writeFileSync(fake, "#!/bin/sh\nenv\n", { mode: 0o755 });
    vi.stubEnv("CODEMM_SECRET_FOR_TEST", "leaked");
    vi.stubEnv("WASMTIME_BACKTRACE_DETAILS", "1");
    const s = await start("cat");
    const r = await startWasi({ ...s, engine: { ...s.engine, bin: fake } }).done;
    expect(r.stdout.toString()).not.toMatch(/CODEMM_SECRET_FOR_TEST|WASMTIME_|HOME=/);
  });

  it("without an input, keeps stdin open for typed text until `end`", async () => {
    const { input: _, ...rest } = await start("cat");
    const run = startWasi(rest);
    expect(run.write("typed\n")).toBe(true);
    run.end();
    const r = await run.done;
    expect(r.stdout.toString()).toBe("typed\n");
    expect(run.write("late\n")).toBe(false);
  });

  it("`kill` stops it", async () => {
    const { input: _, ...rest } = await start("cat");
    const run = startWasi({ ...rest, timeMs: 60_000 });
    run.kill();
    const r = await run.done;
    expect(r).toMatchObject({ timedOut: false, exit: 137 });
  });
});
