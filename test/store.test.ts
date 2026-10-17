import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, materialize, readEvents, withLock, withWorkspaceLock } from "../src/store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codemm-home-"));
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
    const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
    const alias = join(mkdtempSync(join(tmpdir(), "codemm-alias-")), "ws");
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
    const real = mkdtempSync(join(tmpdir(), "codemm-ws-"));
    const alias = join(mkdtempSync(join(tmpdir(), "codemm-alias-")), "ws");
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
    const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
    materialize(ws, "exercises/demo/sum", { "main.sh": "starter", "README.md": "v1" });
    writeFileSync(join(ws, "exercises/demo/sum/main.sh"), "my edit");
    materialize(ws, "exercises/demo/sum", { "main.sh": "starter", "README.md": "v1", "tests/01.in": "1" });
    expect(readFileSync(join(ws, "exercises/demo/sum/main.sh"), "utf8")).toBe("my edit");
    expect(readFileSync(join(ws, "exercises/demo/sum/tests/01.in"), "utf8")).toBe("1");
  });

  it("refuses to write through a symlinked folder", () => {
    const ws = mkdtempSync(join(tmpdir(), "codemm-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "codemm-outside-"));
    symlinkSync(outside, join(ws, "exercises"));
    expect(() => materialize(ws, "exercises/demo/sum", { "main.sh": "x" })).toThrow(/symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("corrupted records", () => {
  it("reports a bad exercise record without echoing its contents", async () => {
    const { listExercises } = await import("../src/store.js");
    const dir = join(home, "courses", "demo", "exercises", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exercise.json"), JSON.stringify({ format_version: 1, slug: "x", expected: { "hidden/SECRET_TEST_NAME": 5 } }));
    expect(() => listExercises("demo")).toThrow(/exercise\.json/);
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
