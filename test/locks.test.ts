import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { npm } from "./npm.js";

/** Cross-process lock tests run the built store, so each worker is a real separate process. */
const root = join(import.meta.dirname, "..");
beforeAll(() => {
  npm(["run", "build"], root);
}, 120_000);

const WORKER = `
import { withLock } from ${JSON.stringify(join(root, "dist", "store.js"))};
import { readFileSync, writeFileSync } from "node:fs";
const [lock, counter] = process.argv.slice(1); // node -e has no script path in argv
await withLock(lock, async () => {
  const n = Number(readFileSync(counter, "utf8"));
  await new Promise((r) => setTimeout(r, 20)); // widen the race window
  writeFileSync(counter, String(n + 1));
});
`;

function runWorkers(n: number, lock: string, counter: string): Promise<number[]> {
  return Promise.all(
    Array.from({ length: n }, () => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER, lock, counter], { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? -1));
    })),
  );
}

describe("withLock across processes", () => {
  it("serializes concurrent writers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-lock-"));
    const counter = join(dir, "n");
    writeFileSync(counter, "0");
    expect(await runWorkers(12, join(dir, "x.lock"), counter)).toEqual(Array(12).fill(0));
    expect(readFileSync(counter, "utf8")).toBe("12");
  });

  it("lets exactly one process at a time take over a stale lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemm-lock-"));
    const counter = join(dir, "n");
    const lock = join(dir, "x.lock");
    writeFileSync(counter, "0");
    const dead = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    writeFileSync(lock, JSON.stringify({ pid: dead, token: "stale", at: "then" }));
    expect(await runWorkers(12, lock, counter)).toEqual(Array(12).fill(0));
    expect(readFileSync(counter, "utf8")).toBe("12");
  });
});
