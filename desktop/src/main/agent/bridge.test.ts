// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ask, run, spawnable, type Executable } from './bridge';

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

  // Stopping is confirmed only when it is (§3.1): anything else is unconfirmed, and blocks new jobs.
  const withGrandchild = (detached: boolean, parentExits = false) =>
    node(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ${detached}, stdio: ['ignore', 'inherit', 'ignore'] });
          ${detached ? 'c.unref();' : ''} console.log(JSON.stringify({ child: c.pid })); ${parentExits ? 'setTimeout(() => process.exit(0), 100)' : 'setInterval(() => {}, 1000)'}`);
  const cancelAfterFirstEvent = async ([exe, args]: [Executable, string[]], waitMs = 0) => {
    const controller = new AbortController();
    let grandchild = 0;
    const out = run(exe, args, parse, {
      onEvent: (e) => {
        grandchild = e.child as number;
        setTimeout(() => controller.abort(), waitMs);
      },
      signal: controller.signal,
      killAfterMs: 300,
    });
    const result = await Promise.race([out, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 15_000))]);
    const survived = grandchild > 0 && alive(grandchild);
    if (survived) process.kill(grandchild, 'SIGKILL');
    return { result, survived };
  };

  it('confirms a cancel once the agent and a grandchild holding its output are gone', async () => {
    const { result, survived } = await cancelAfterFirstEvent(withGrandchild(false));
    expect(result).toMatchObject({ cancelled: true, stopped: true });
    expect(survived).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('leaves a cancel unconfirmed, but settled, when a descendant left the group and holds the output', async () => {
    const { result, survived } = await cancelAfterFirstEvent(withGrandchild(true));
    expect(result).toMatchObject({ cancelled: true, stopped: false });
    expect(survived).toBe(true);
  });

  it('a parent that already exited: POSIX confirms through its group; Windows cannot check the tree, so it is unconfirmed', async () => {
    const { result } = await cancelAfterFirstEvent(withGrandchild(false, true), 500);
    expect(result).toMatchObject({ cancelled: true, stopped: process.platform !== 'win32' });
  });

  it('delivers no event after a run settles', async () => {
    const controller = new AbortController();
    let events = 0;
    const out = run(...node(`setInterval(() => console.log('{"tick":1}'), 10)`), parse, {
      onEvent: () => {
        events++;
        controller.abort();
      },
      signal: controller.signal,
      killAfterMs: 300,
    });
    await out;
    const settledAt = events;
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toBe(settledAt);
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
