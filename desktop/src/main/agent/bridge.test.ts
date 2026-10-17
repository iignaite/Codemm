// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ask, run, spawnable, treeKillConfirmed, type Executable } from './bridge';

const parse = (line: string) => (line.startsWith('{') ? [JSON.parse(line) as Record<string, unknown>] : []);
/** A fake agent: this Node running a script, the way the app runs a JavaScript agent. */
const node = (code: string): [Executable, string[]] => [{ path: process.execPath, js: false }, ['-e', code]];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('bridge (D5)', () => {
  it('runs a JavaScript agent with the app itself as Node', () => {
    const target = spawnable({ path: '/x/codex.js', js: true }, ['exec'], '/Applications/Codemm.app/Contents/MacOS/Codemm');
    expect(target).toMatchObject({ file: '/Applications/Codemm.app/Contents/MacOS/Codemm', args: ['/x/codex.js', 'exec'] });
    expect(target.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(spawnable({ path: '/bin/claude', js: false }, ['-p']).env.ELECTRON_RUN_AS_NODE).toBe(process.env.ELECTRON_RUN_AS_NODE);
  });

  it('streams parsed events line by line and reports the exit code', async () => {
    const events: unknown[] = [];
    const out = await run(...node(`process.stdout.write('{"n":1}\\nnoise\\n{"n"'); setTimeout(() => process.stdout.write(':2}\\n'), 50)`), parse, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    expect(out).toEqual({ code: 0, cancelled: false });
  });

  it('gives the agent no stdin, so it never waits for input', async () => {
    const events: unknown[] = [];
    await run(...node(`process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('{"stdin":"closed"}'))`), parse, { onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ stdin: 'closed' }]);
  });

  it("passes the app's environment unchanged (O1)", async () => {
    process.env.CODEMM_TEST_VALUE = 'kept';
    try {
      const events: unknown[] = [];
      await run(...node(`console.log(JSON.stringify({ v: process.env.CODEMM_TEST_VALUE }))`), parse, { onEvent: (e) => events.push(e) });
      expect(events).toEqual([{ v: 'kept' }]);
    } finally {
      delete process.env.CODEMM_TEST_VALUE;
    }
  });

  // On Windows this checks `taskkill /t /f` on the process tree; on POSIX, SIGTERM then SIGKILL to the group.
  it('cancel resolves only after the whole group is gone, even a child that ignores SIGTERM', async () => {
    const controller = new AbortController();
    let child = 0;
    const out = run(
      ...node(`const c = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
              setTimeout(() => console.log(JSON.stringify({ child: c.pid })), 200); setInterval(() => {}, 1000)`),
      parse,
      {
        onEvent: (e) => {
          child = e.child as number;
          controller.abort();
        },
        signal: controller.signal,
        killAfterMs: 300,
      },
    );
    expect(await out).toMatchObject({ cancelled: true, stopped: true });
    expect(alive(child)).toBe(false);
  });

  it('a cancel resolves once the agent is stopped, even when a descendant keeps the output pipe open', async () => {
    const controller = new AbortController();
    let descendant = 0;
    const out = run(
      ...node(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
              c.unref(); console.log(JSON.stringify({ child: c.pid })); setInterval(() => {}, 1000)`),
      parse,
      {
        onEvent: (e) => {
          descendant = e.child as number;
          controller.abort();
        },
        signal: controller.signal,
        killAfterMs: 300,
      },
    );
    try {
      const result = await Promise.race([out, new Promise((r) => setTimeout(() => r('still waiting'), 10_000))]);
      expect(result).toMatchObject({ cancelled: true });
    } finally {
      if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
    }
  });

  it('confirms a Windows tree kill only when it worked, or the agent had already ended on its own (N1)', () => {
    expect(treeKillConfirmed(0, false)).toBe(true);
    // taskkill's "not found": the agent finished its turn before the kill, like any finished turn.
    expect(treeKillConfirmed(128, true)).toBe(true);
    // Any other failure leaves descendants unconfirmed, even with the parent gone.
    expect(treeKillConfirmed(128, false)).toBe(false);
    expect(treeKillConfirmed(1, true)).toBe(false);
    expect(treeKillConfirmed(null, true)).toBe(false);
  });

  it('never starts a job cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run({ path: '/no/such/agent', js: false }, [], parse, { signal: controller.signal })).toEqual({ code: null, cancelled: true });
  });

  it('survives a parser that throws and drops overlong lines', async () => {
    const events: unknown[] = [];
    const throwing = (line: string) => {
      if (line === 'bad') throw new Error('boom');
      return parse(line);
    };
    const long = JSON.stringify({ pad: 'x'.repeat(5000) });
    const out = await run(...node(`console.log('bad'); console.log('${long}'); process.stdout.write('${long}'.slice(0, 3000)); setTimeout(() => console.log('${long}'.slice(3000) + '\\n{"ok":1}'), 50)`), throwing, {
      onEvent: (e) => events.push(e),
      maxLine: 1000,
    });
    expect(events).toEqual([{ ok: 1 }]);
    expect(out.code).toBe(0);
  });

  it('status commands keep only what read() returns, stop at the deadline and read at most the cap', async () => {
    const read = ({ code, output }: { code: number | null; output: string }) => code === 0 && /logged in/.test(output);
    const [exe] = node('');
    expect(await ask(exe, ['-e', "console.log('email@example.com logged in')"], read)).toBe(true);
    expect(await ask(exe, ['-e', 'process.exit(3)'], read)).toBe(false);
    expect(await ask({ path: '/no/such/agent', js: false }, [], read)).toBeNull();
    const started = Date.now();
    const holdsPipe = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)";
    expect(await ask(exe, ['-e', holdsPipe], read, { timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await ask(exe, ['-e', "console.log('x'.repeat(100000) + ' logged in')"], read, { maxOutput: 1000 })).toBe(false);
  });
});
