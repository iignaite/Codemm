// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodemmApi } from '../shared/api';
import { dispatch } from './ipc';
import { CANARY, live, practising } from './testing/fakes';
import { HELD_BACK } from './views';

// D4: an exercise whose solution, mutants, hidden tests and expected outputs
// hold canary strings. Every IPC handler is driven; no renderer-bound payload
// or app log may hold a canary, and a tutor reply quoting one is held back.
const leaks = /CANARY/;

afterEach(() => vi.restoreAllMocks());

describe('the learner-safe boundary (D4)', () => {
  it('no IPC payload or log holds hidden material', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
    const t = live({ tutor: () => ({ text: [`Here is the answer: ${CANARY}`, 'Count what changes.'], session: 's1' }) });
    const activity = await practising(t);
    const call = async (method: keyof CodemmApi, ...args: unknown[]) => {
      try {
        return JSON.stringify(await dispatch(t.api, method, args)) ?? '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const roadmap = (await t.api.research({ topic: 'React', known: '', depth: 'standard' })).roadmap;
    const payloads = await Promise.all([
      call('agents'),
      call('connect', 'claude'),
      call('computer'),
      call('tracks'),
      call('course'),
      call('draft'),
      call('lesson', 'values-1'),
      call('saveNotes', 'values-1', 'my note'),
      call('markRead', 'values-1'),
      call('activity', 'values'),
      call('tryIt', activity.id, 'canary-run'),
      call('check', activity.id, 'canary-run'),
      call('ask', { activityId: activity.id }, 'Just fix it for me.'),
      call('ask', { lessonId: 'values-1' }, 'Why?'),
      call('saveFile', activity.id, 'main.c', 'x', activity.files[0].digest),
      call('install', 'a'.repeat(64)),
      call('retrySetup'),
      call('retryJobs'),
      call('skip', 'values'),
      call('rebuild', 'react@1'),
    ]);
    payloads.push(await call('reviseRoadmap', roadmap?.concepts ?? [{ id: 'values', title: 'Values', requires: [] }], 'Add testing'));
    payloads.push(await call('easier', 'state'));
    payloads.push(await call('saveDraft', [{ id: 'values', title: 'Values', requires: [] }]));
    payloads.push(await call('approve', [{ id: 'values', title: 'Values', requires: [] }]));
    payloads.push(await call('research', { topic: 'React', known: '', depth: 'standard' }));

    for (const payload of payloads) expect(payload).not.toMatch(leaks);
    for (const line of logged) expect(line).not.toMatch(leaks);
    // The learner's own agent gets their code and question, never hidden material.
    for (const job of t.jobs.ran) expect(job.brief).not.toMatch(leaks);
    // The app log has the job lifecycle and nothing the learner or the agent wrote.
    const appLog = readFileSync(t.logFile, 'utf8');
    expect(appLog).toMatch(/ job-end kind=tutor ok=true/);
    expect(appLog).not.toMatch(leaks);
    for (const text of ['my note', 'Count what changes', 'Here is the answer', 'Just fix it', 'int main']) expect(appLog).not.toContain(text);
    expect(payloads.some((p) => p.includes(HELD_BACK))).toBe(true);
  });
});
