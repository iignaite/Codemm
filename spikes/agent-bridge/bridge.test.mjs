import assert from "node:assert/strict";
import { test } from "node:test";
import { run, signedIn } from "./bridge.mjs";

const parse = (line) => (line.startsWith("{") ? [JSON.parse(line)] : []);
const node = (code) => ({ command: process.execPath, args: ["-e", code] });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("run streams parsed events line by line and reports the exit code", async () => {
  const events = [];
  const out = await run(node(`process.stdout.write('{"n":1}\\nnoise\\n{"n"'); setTimeout(() => process.stdout.write(':2}\\n'), 50)`), parse, {
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(out, { code: 0, cancelled: false });
});

test("run gives the agent no stdin, so it never waits for input", async () => {
  const events = [];
  await run(node(`process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('{"stdin":"closed"}'))`), parse, { onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ stdin: "closed" }]);
});

test("run removes credential variables from the agent's environment", async () => {
  process.env.ANTHROPIC_API_KEY = "secret";
  try {
    const events = [];
    await run(node(`console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null }))`), parse, { onEvent: (e) => events.push(e) });
    assert.deepEqual(events, [{ key: null }]);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("cancel resolves only after the whole group is gone, even a child that ignores SIGTERM", async () => {
  const controller = new AbortController();
  let child;
  const out = run(
    node(`const c = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
          setTimeout(() => console.log(JSON.stringify({ child: c.pid })), 200); setInterval(() => {}, 1000)`),
    parse,
    {
      onEvent: (e) => {
        child = e.child;
        controller.abort();
      },
      signal: controller.signal,
      killAfterMs: 300,
    },
  );
  assert.deepEqual(await out, { code: null, cancelled: true, stopped: true });
  assert.equal(alive(child), false);
});

test("an already-cancelled run never starts the agent", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await run({ command: "/no/such/agent", args: [] }, parse, { signal: controller.signal }), { code: null, cancelled: true });
});

test("a parser that throws or an overlong line never crashes the run", async () => {
  const events = [];
  const throwing = (line) => {
    if (line === "bad") throw new Error("boom");
    return parse(line);
  };
  const long = JSON.stringify({ pad: "x".repeat(5000) });
  const out = await run(node(`console.log('bad'); console.log('${long}'); process.stdout.write('${long}'.slice(0, 3000)); setTimeout(() => console.log('${long}'.slice(3000) + '\\n{"ok":1}'), 50)`), throwing, {
    onEvent: (e) => events.push(e),
    maxLine: 1000,
  });
  assert.deepEqual(events, [{ ok: 1 }]);
  assert.equal(out.code, 0);
});

test("signedIn runs the status command and keeps only the yes or no", async () => {
  const yes = { command: process.execPath, args: ["-e", "console.log('email@example.com logged in')"], read: ({ code, output }) => code === 0 && /logged in/.test(output) };
  assert.equal(await signedIn(yes), true);
  assert.equal(await signedIn({ ...yes, args: ["-e", "process.exit(3)"] }), false);
  assert.equal(await signedIn({ ...yes, command: "/no/such/agent" }), false);
  const started = Date.now();
  const holdsPipe = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)";
  assert.equal(await signedIn({ ...yes, args: ["-e", holdsPipe] }, { timeoutMs: 300 }), false);
  assert.ok(Date.now() - started < 1000, "the deadline holds even when a child keeps the pipe open");
  const chatty = { ...yes, args: ["-e", "console.log('x'.repeat(100000) + ' logged in')"] };
  assert.equal(await signedIn(chatty, { maxOutput: 1000 }), false, "output past the cap is not read");
});
