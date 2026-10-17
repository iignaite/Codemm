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

test("cancel stops the agent and the processes it started", async () => {
  const controller = new AbortController();
  let child;
  const out = run(
    node(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          console.log(JSON.stringify({ child: c.pid })); setInterval(() => {}, 1000)`),
    parse,
    {
      onEvent: (e) => {
        child = e.child;
        controller.abort();
      },
      signal: controller.signal,
    },
  );
  assert.equal((await out).cancelled, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(child), false);
});

test("signedIn runs the status command and keeps only the yes or no", async () => {
  const yes = { command: process.execPath, args: ["-e", "console.log('email@example.com logged in')"], read: ({ code, output }) => code === 0 && /logged in/.test(output) };
  assert.equal(await signedIn(yes), true);
  assert.equal(await signedIn({ ...yes, args: ["-e", "process.exit(3)"] }), false);
  assert.equal(await signedIn({ ...yes, command: "/no/such/agent" }), false);
});
