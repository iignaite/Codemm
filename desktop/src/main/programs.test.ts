// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { RunOutput } from '../shared/api';
import type { CoreProgramRun } from './core/types';
import { programs, type StartProgram } from './programs';

type End = Awaited<CoreProgramRun['done']>;

/** A program that prints its prompt, then ends when told to. */
function fake() {
  let end!: (r: End) => void;
  const done = new Promise<End>((r) => (end = r));
  const written: string[] = [];
  const start: StartProgram = async (output, { onStart }) => {
    onStart('run', 120_000);
    output('name? ', 'stdout');
    return { write: (t) => (written.push(t), true), kill: () => end({ exit: 137, timedOut: false, flooded: false, stopped: true }), done };
  };
  return { start, end, written };
}

function subject(ready: () => Promise<void> = async () => {}) {
  const heard: RunOutput[] = [];
  const logged: unknown[] = [];
  const p = programs({
    whenDockerReady: (operation) => ready().then(operation),
    notCounted: (e) => ((e as Error).message === 'docker down' ? "Docker isn't running." : null),
    log: (event, fields) => void logged.push([event, fields]),
  });
  p.onOutput((o) => heard.push(o));
  return { p, heard, logged };
}

describe("Run's programs (§4.10)", () => {
  it('tags what a program prints with its run, takes input, and ends with how it ended', async () => {
    const { p, heard } = subject();
    const f = fake();
    const ran = p.start('run-1', f.start);
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(await p.input('run-1', 'Ada\n')).toBe(true);
    f.end({ exit: 0, stage: 'run', timedOut: false, flooded: false });
    expect(await ran).toEqual({ kind: 'ran', exit: 0, stage: 'run', timedOut: false, stopped: false, flooded: false, outOfMemory: false });
    expect(heard).toEqual([{ run: 'run-1', started: 'run', limitMs: 120_000 }, { run: 'run-1', stream: 'stdout', text: 'name? ' }]);
    expect(f.written).toEqual(['Ada\n']);
    expect(await p.input('run-1', 'late\n')).toBe(false);
  });

  it('refuses a run id already running, and more than four programs at once', async () => {
    const { p } = subject();
    const runs = [1, 2, 3, 4].map((n) => p.start(`run-${n}`, fake().start));
    await expect(p.start('run-1', fake().start)).rejects.toThrow('Bad input');
    await expect(p.start('run-5', fake().start)).rejects.toThrow('Too many programs are running. Stop one, then try again.');
    for (const n of [1, 2, 3, 4]) await p.stop(`run-${n}`);
    for (const r of runs) expect(await r).toMatchObject({ stopped: true });
  });

  it('stopped while waiting for Docker, it ends at once, frees its place, and never starts', async () => {
    let ready!: () => void;
    const { p } = subject(() => new Promise<void>((r) => (ready = r)));
    const f = fake();
    const startSpy = vi.fn(f.start);
    const ran = p.start('run-1', startSpy);
    await p.stop('run-1');
    expect(await ran).toEqual({ kind: 'ran', exit: 137, timedOut: false, stopped: true, flooded: false, outOfMemory: false });
    ready();
    await new Promise((r) => setTimeout(r, 5));
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("says why it didn't run when Docker is down, and logs it", async () => {
    const { p, logged } = subject();
    expect(await p.start('run-1', async () => Promise.reject(new Error('docker down')))).toEqual({ kind: 'not-run', reason: "Docker isn't running." });
    expect(logged).toEqual([['not-counted', { run: 'program', reason: "Docker isn't running." }]]);
    await expect(p.start('run-2', async () => Promise.reject(new Error('other')))).rejects.toThrow('other');
  });

  it('stops every program when Codemm quits', async () => {
    const { p } = subject();
    const runs = [p.start('a', fake().start), p.start('b', fake().start)];
    await new Promise((r) => setTimeout(r, 5));
    p.stopAll();
    for (const r of runs) expect(await r).toMatchObject({ stopped: true });
  });
});
