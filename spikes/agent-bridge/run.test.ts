import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { members, startTurn } from "./run.ts";

const agent = fileURLToPath(new URL("fixtures/stubborn-agent.mjs", import.meta.url));
const start = (mode: string) => {
  const lines: string[] = [];
  const turn = startTurn({ command: process.execPath, args: [agent, mode], cwd: process.cwd(), env: process.env, input: "", onLine: (l) => lines.push(l), graceMs: 300 });
  return { lines, turn };
};
const started = (lines: string[]) => new Promise<void>((resolve) => {
  const wait = () => (lines.length > 0 ? resolve() : setTimeout(wait, 20));
  wait();
});

test("a finished turn leaves nothing running, even a child that ignores SIGTERM", async () => {
  const { lines, turn } = start("exit");
  const result = await turn.done;
  assert.deepEqual(lines, ['{"type":"started"}']);
  assert.equal(result.code, 0);
  assert.equal(result.leftover, 0);
});

test("cancelling escalates to SIGKILL and leaves nothing running", async () => {
  const { lines, turn } = start("hang");
  await started(lines);
  turn.cancel();
  const result = await turn.done;
  assert.equal(result.cancelled, true);
  assert.equal(result.atCancel, 2);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.leftover, 0);
});

test("a group that can't be inspected is an error, never an empty group", () => {
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(() => members(process.pid), /inspect/);
  } finally {
    process.env.PATH = path;
  }
});

test("cleanup still kills everything when the group can't be inspected, and says it couldn't check", async () => {
  const { lines, turn } = start("hang");
  await started(lines);
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    turn.cancel();
    const result = await turn.done;
    assert.equal(result.cancelled, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.atCancel, null);
    assert.equal(result.leftover, null);
  } finally {
    process.env.PATH = path;
  }
  // Signal 0 only checks existence: the whole group must be gone.
  assert.throws(() => process.kill(-turn.pid, 0), { code: "ESRCH" });
});
