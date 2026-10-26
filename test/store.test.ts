import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, assertFreeSpace, digestText, materialize, readEvents, replaceLearnerFile, trackImageTag, withLock, withWorkspaceLock, writeTextAtomic } from "../src/store.js";
import * as store from "../src/store.js";
import { tempDir } from "./temp.js";

let home: string;
beforeEach(() => {
  home = tempDir("codemm-home-");
  process.env.CODEMM_HOME = home;
});

const ev = (n: number) => ({ format_version: 1 as const, kind: "skip" as const, at: `2026-10-17T00:00:0${n}Z`, concept: `c${n}` });
const eventsPath = () => join(home, "courses", "demo", "events.jsonl");

describe("events log", () => {
  it("appends and replays events in order", () => {
    appendEvent("demo", ev(1));
    appendEvent("demo", ev(2));
    expect(readEvents("demo")).toEqual([ev(1), ev(2)]);
  });

  it("ignores a torn final line, then backs it up and repairs it before the next append", () => {
    appendEvent("demo", ev(1));
    writeFileSync(eventsPath(), `${readFileSync(eventsPath(), "utf8")}{"format_ver`);
    expect(readEvents("demo")).toEqual([ev(1)]);
    appendEvent("demo", ev(2));
    expect(readEvents("demo")).toEqual([ev(1), ev(2)]);
    expect(readdirSync(join(home, "courses", "demo")).some((f) => f.startsWith("events.jsonl.bak-"))).toBe(true);
  });

  it("refuses to change a log with a corrupt line in the middle", () => {
    mkdirSync(join(home, "courses", "demo"), { recursive: true });
    writeFileSync(eventsPath(), `${JSON.stringify(ev(1))}\nnot json\n${JSON.stringify(ev(2))}\n`);
    expect(() => readEvents("demo")).toThrow(/line 2/);
    expect(() => appendEvent("demo", ev(3))).toThrow(/line 2/);
  });
});

describe("withLock", () => {
  it("runs the work and releases the lock", async () => {
    const lock = join(home, "x.lock");
    expect(await withLock(lock, async () => 42)).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a lock whose owner process is gone", async () => {
    const lock = join(home, "x.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    writeFileSync(lock, JSON.stringify({ pid: Number(dead), at: new Date().toISOString() }));
    expect(await withLock(lock, async () => "ok")).toBe("ok");
  });

  it("waits for a live owner, then gives up with a clear error", async () => {
    const lock = join(home, "x.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await expect(withLock(lock, async () => "never", 300)).rejects.toThrow(/busy/i);
  });
});

describe("withWorkspaceLock", () => {
  it("is one lock for every spelling of the workspace", async () => {
    const ws = tempDir("codemm-ws-");
    const alias = join(tempDir("codemm-alias-"), "ws");
    symlinkSync(ws, alias);
    const order: string[] = [];
    const slow = withWorkspaceLock(ws, async () => {
      order.push("first in");
      await new Promise((r) => setTimeout(r, 300));
      order.push("first out");
    });
    await new Promise((r) => setTimeout(r, 50));
    await withWorkspaceLock(alias, async () => order.push("second"));
    await slow;
    expect(order).toEqual(["first in", "first out", "second"]);
  });
});

describe("withWorkspaceLock for a folder that doesn't exist yet", () => {
  it("is the same lock before and after the folder is created", async () => {
    const real = tempDir("codemm-ws-");
    const alias = join(tempDir("codemm-alias-"), "ws");
    symlinkSync(real, alias);
    const order: string[] = [];
    const slow = withWorkspaceLock(join(alias, "new"), async () => {
      order.push("first in");
      await new Promise((r) => setTimeout(r, 300));
      order.push("first out");
    });
    await new Promise((r) => setTimeout(r, 50));
    await withWorkspaceLock(join(real, "new"), async () => order.push("second"));
    await slow;
    expect(order).toEqual(["first in", "first out", "second"]);
  });
});

describe("materialize", () => {
  it("writes missing files and never overwrites the learner's edits", () => {
    const ws = tempDir("codemm-ws-");
    materialize(ws, "exercises/demo/sum", { "main.sh": "starter", "README.md": "v1" });
    writeFileSync(join(ws, "exercises/demo/sum/main.sh"), "my edit");
    materialize(ws, "exercises/demo/sum", { "main.sh": "starter", "README.md": "v1", "tests/01.in": "1" });
    expect(readFileSync(join(ws, "exercises/demo/sum/main.sh"), "utf8")).toBe("my edit");
    expect(readFileSync(join(ws, "exercises/demo/sum/tests/01.in"), "utf8")).toBe("1");
  });

  it("refuses to write through a symlinked folder", () => {
    const ws = tempDir("codemm-ws-");
    const outside = tempDir("codemm-outside-");
    symlinkSync(outside, join(ws, "exercises"));
    expect(() => materialize(ws, "exercises/demo/sum", { "main.sh": "x" })).toThrow(/symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("file modes", () => {
  it("keeps the umask's modes for Codemm's own files, and 0644 for learner files", () => {
    const old = process.umask(0o002);
    try {
      const ws = tempDir("codemm-ws-");
      const mode = (path: string) => statSync(join(ws, path)).mode & 0o777;
      writeTextAtomic(join(ws, "own.json"), "{}");
      expect(mode("own.json")).toBe(0o664);
      materialize(ws, "ex", { "main.sh": "a" });
      expect(mode("ex/main.sh")).toBe(0o644);
      replaceLearnerFile(ws, "ex", "main.sh", "b", digestText("a"));
      expect(mode("ex/main.sh")).toBe(0o644);
    } finally {
      process.umask(old);
    }
  });
});

describe("corrupted records", () => {
  it("reports a bad exercise record without echoing its contents", async () => {
    const { listExercises } = await import("../src/store.js");
    const dir = join(home, "courses", "demo", "exercises", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exercise.json"), JSON.stringify({ format_version: 1, slug: "x", expected: { "hidden/SECRET_TEST_NAME": 5 } }));
    expect(() => listExercises("demo")).toThrow(expect.objectContaining({ kind: "damaged", message: expect.stringMatching(/exercise\.json/) }));
    expect(() => listExercises("demo")).not.toThrow(/SECRET_TEST_NAME/);
  });
});

describe("generated records", () => {
  it("reads an exercise at the author file limit plus Codemm's own record", async () => {
    const { readExercise } = await import("../src/store.js");
    const dir = join(home, "courses", "demo", "exercises", "big");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 256; i++) writeFileSync(join(dir, `f${i}`), "x");
    const record = { format_version: 1, slug: "big", style: "io", concepts: ["c"], difficulty: 1, track: "t@1", createdAt: "now", expected: { "hidden/01": "y".repeat(2_000_000) } };
    writeFileSync(join(dir, "exercise.json"), JSON.stringify(record));
    const loaded = readExercise("demo", "big");
    expect(Object.keys(loaded.files)).toHaveLength(256);
    expect(loaded.record.slug).toBe("big");
  });
});

describe("assertFreeSpace", () => {
  it("refuses when the volume has less free space than setup needs", () => {
    expect(() => assertFreeSpace(home, Number.MAX_SAFE_INTEGER)).toThrow(expect.objectContaining({ kind: "disk", message: expect.stringMatching(/Not enough disk space/) }));
    expect(() => assertFreeSpace(home, 1)).not.toThrow();
  });
});

describe("trackImageTag", () => {
  it("names a track's image after its Codemm home, so two homes on one Docker never share a tag", () => {
    const a = trackImageTag("python", 1);
    expect(a).toMatch(/^codemm-track-[0-9a-f]{8}-python:1$/);
    expect(trackImageTag("python", 1)).toBe(a);
    const other = tempDir("codemm-home-");
    process.env.CODEMM_HOME = other;
    expect(trackImageTag("python", 1)).not.toBe(a);
    // The same home spelled through a symlink is the same home.
    const link = join(tempDir("codemm-link-"), "home");
    symlinkSync(other, link);
    const direct = trackImageTag("python", 1);
    process.env.CODEMM_HOME = link;
    expect(trackImageTag("python", 1)).toBe(direct);
  });
});

describe("toolchain folders", () => {
  const base = { format_version: 1 as const, id: "py", version: 1, styles: ["io" as const], files: ["main.py"], run: "/work/src/main.py", limits: { time_ms: 2000, memory_mb: 256 }, installedAt: "now" };

  it("names a toolchain's folder by its digest, and refuses anything else", () => {
    expect(store.toolchainDir("a".repeat(64))).toBe(join(store.codemmHome(), "toolchains", "a".repeat(64)));
    expect(() => store.toolchainDir("../x")).toThrow(/Invalid toolchain digest/);
  });

  it("runs a Docker track by its image ID, and a WASI track from its toolchain folder", () => {
    expect(store.judgeTrack({ ...base, image: "tag", imageId: "sha256:x" })).toMatchObject({ image: "sha256:x" });
    expect(store.judgeTrack({ ...base, image: "tag", imageId: "sha256:x" }).wasi).toBeUndefined();
    const wasi = { sha256: "b".repeat(64), module: "python.wasm", dirs: { "/lib": "lib" }, env: { A: "1" } };
    expect(store.judgeTrack({ ...base, wasi })).toMatchObject({
      image: "", run: "/work/src/main.py", wasi: { root: store.toolchainDir("b".repeat(64)), module: "python.wasm", dirs: { "/lib": "lib" }, env: { A: "1" } },
    });
  });
});
