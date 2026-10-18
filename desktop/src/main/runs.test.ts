import { describe, expect, it } from 'vitest';
import { bindRuns } from './runs';

type Window = { id: string };
const a: Window = { id: 'a' };
const b: Window = { id: 'b' };

/** A handler that records calls and lets a test end a Run when it likes. */
function fakeHandler() {
  const calls: string[] = [];
  const ends: Record<string, (value: unknown) => void> = {};
  const handle = (event: { sender: Window }, method: unknown, args: unknown) => {
    calls.push(`${event.sender.id} ${String(method)} ${JSON.stringify(args)}`);
    if (method === 'runProgram') return new Promise((resolve) => (ends[(args as string[])[1]] = resolve));
    return Promise.resolve(method === 'sendRunInput' ? true : undefined);
  };
  return { calls, ends, handle };
}

describe('bindRuns', () => {
  it('lets only the window that started a Run send it input, stop it, or hear it', async () => {
    const h = fakeHandler();
    const runs = bindRuns<Window>();
    const invoke = runs.wrap(h.handle);
    void invoke({ sender: a }, 'runProgram', ['act-1', 'run-1']);
    expect(runs.ownerOf('run-1')).toBe(a);

    expect(await invoke({ sender: b }, 'sendRunInput', ['run-1', 'x\n'])).toBe(false);
    expect(await invoke({ sender: b }, 'stopRun', ['run-1'])).toBeUndefined();
    expect(h.calls.filter((c) => c.startsWith('b'))).toEqual([]);

    expect(await invoke({ sender: a }, 'sendRunInput', ['run-1', 'x\n'])).toBe(true);
    await invoke({ sender: a }, 'stopRun', ['run-1']);
    expect(h.calls).toEqual(['a runProgram ["act-1","run-1"]', 'a sendRunInput ["run-1","x\\n"]', 'a stopRun ["run-1"]']);
  });

  it('forgets a Run once it ends, and lists a window\'s Runs so they stop when it closes', async () => {
    const h = fakeHandler();
    const runs = bindRuns<Window>();
    const invoke = runs.wrap(h.handle);
    const first = invoke({ sender: a }, 'runProgram', ['act-1', 'run-1']);
    void invoke({ sender: a }, 'runProgram', ['act-1', 'run-2']);
    void invoke({ sender: b }, 'runProgram', ['act-1', 'run-3']);
    expect(runs.runsOf(a)).toEqual(['run-1', 'run-2']);

    h.ends['run-1']({ kind: 'ran' });
    await first;
    expect(runs.ownerOf('run-1')).toBeUndefined();
    expect(runs.runsOf(a)).toEqual(['run-2']);
    expect(await invoke({ sender: a }, 'sendRunInput', ['run-1', 'late\n'])).toBe(false);
  });

  it('refuses a run id already in use, without touching the Run that has it', async () => {
    const h = fakeHandler();
    const runs = bindRuns<Window>();
    const invoke = runs.wrap(h.handle);
    void invoke({ sender: a }, 'runProgram', ['act-1', 'run-1']);
    await expect(invoke({ sender: b }, 'runProgram', ['act-1', 'run-1'])).rejects.toThrow('Bad input');
    expect(runs.ownerOf('run-1')).toBe(a);
  });

  it('forgets a Run the handler refused', async () => {
    const runs = bindRuns<Window>();
    const invoke = runs.wrap(() => Promise.reject(new Error('Unknown sender')));
    await expect(invoke({ sender: a }, 'runProgram', ['act-1', 'run-1'])).rejects.toThrow('Unknown sender');
    expect(runs.ownerOf('run-1')).toBeUndefined();
  });

  it('passes every other call straight through', async () => {
    const h = fakeHandler();
    const invoke = bindRuns<Window>().wrap(h.handle);
    await invoke({ sender: a }, 'lesson', ['values-1']);
    expect(h.calls).toEqual(['a lesson ["values-1"]']);
  });
});
