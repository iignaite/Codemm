// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGED, OFFLINE, UNSTOPPABLE } from '../shared/api';
import { INTERNAL, safeError } from './errors';
import { handler } from './ipc';
import { createLog } from './log';
import { live, practising } from './testing/fakes';

const HIDDEN = 'tests/hidden/secret-edge-case.in';
const appFrame = { fromApp: true };

describe('errors at the IPC boundary (D4)', () => {
  it('a file system error naming a hidden file reaches neither the renderer nor the log', async () => {
    const t = live();
    const activity = await practising(t);
    t.app.getExercise = async () => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '/h/courses/c/exercises/x/${HIDDEN}'`), { code: 'ENOENT', syscall: 'open', path: `/h/${HIDDEN}` });
    };
    const handle = handler(t.api, createLog(t.dir), (e: typeof appFrame) => e.fromApp);
    const failure = await handle(appFrame, 'activity', [activity.concept]).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(INTERNAL);
    expect(JSON.stringify(failure)).not.toContain('secret');
    const log = readFileSync(t.logFile, 'utf8');
    expect(log).toMatch(/ ipc-error method=activity kind=internal name=Error code=ENOENT\n/);
    expect(log).not.toContain('secret');
  });

  it("passes Codemm's codes and core's learner-safe messages, and refuses other senders", async () => {
    const t = live();
    const activity = await practising(t);
    const handle = handler(t.api, createLog(t.dir), (e: typeof appFrame) => e.fromApp);
    await t.api.saveFile(activity.id, 'main.c', 'x', activity.files[0].digest);
    await expect(handle(appFrame, 'saveFile', [activity.id, 'main.c', 'y', activity.files[0].digest])).rejects.toThrow(CHANGED);
    t.app.skip = async () => {
      throw Object.assign(new Error('Finish the prerequisites first.'), { name: 'CodemmError' });
    };
    await expect(handle(appFrame, 'skip', ['values'])).rejects.toThrow('Finish the prerequisites first.');
    await expect(handle({ fromApp: false }, 'agents', [])).rejects.toThrow('Unknown sender');
    await expect(handle(appFrame, 'nope', [])).rejects.toThrow('Unknown call');
    expect(readFileSync(t.logFile, 'utf8')).toContain('ipc-error method=unknown kind=desktop name=SafeError');
  });

  it('passes the offline code, so the screen can say the computer is offline', async () => {
    const t = live({ research: () => ({ ok: false, problem: 'offline' }) });
    await t.api.connect('claude');
    const handle = handler(t.api, createLog(t.dir), (e: typeof appFrame) => e.fromApp);
    const goal = { topic: 'React', known: '', depth: 'standard' };
    const research = async () => {
      for (let i = 0; i < 20; i++) {
        if ((await handle(appFrame, 'research', [goal]) as { state: string }).state !== 'running') return;
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await expect(research()).rejects.toThrow(OFFLINE);
  });

  it("passes the code for an agent Codemm couldn't stop", () => {
    expect(safeError(new Error(UNSTOPPABLE)).message).toBe(UNSTOPPABLE);
  });
});
