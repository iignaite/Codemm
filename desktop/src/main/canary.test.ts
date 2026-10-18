// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodemmApi, JobProgress } from '../shared/api';
import { dispatch } from './ipc';
import { CANARY, live, practising, settle } from './testing/fakes';
import { HELD_BACK } from './views';

// D4: an exercise whose solution, mutants, hidden tests and expected outputs
// hold canary strings. Every IPC handler is driven; no renderer-bound payload
// or app log may hold a canary, and a tutor reply quoting one is held back.
const leaks = /CANARY/;
type Method = Exclude<keyof CodemmApi, 'onCheckProgress' | 'onJobProgress' | 'onRunOutput'>;

afterEach(() => vi.restoreAllMocks());

describe('the learner-safe boundary (D4)', () => {
  it('no IPC payload or log holds hidden material', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
    const docker: string[] = [];
    const t: ReturnType<typeof live> = live(
      {
        // A tutor's agent that searches the web anyway (Codex can): only research shows searches and pages (§4.11).
        tutor: (job) => {
          job.onEvent?.({ type: 'progress', step: { kind: 'search', query: `how to solve ${CANARY}` } });
          job.onEvent?.({ type: 'progress', step: { kind: 'read', url: 'example.com/CANARY', href: 'https://example.com/CANARY' } });
          return { text: [`Here is the answer: ${CANARY}`, 'Count what changes.'], session: 's1' };
        },
        // Research reports its steps; once the course has hidden material, one step quotes it and must be dropped.
        research: (job) => {
          job.onEvent?.({ type: 'progress', step: { kind: 'search', query: 'react hooks' } });
          if (t.c.exercises.size > 0) job.onEvent?.({ type: 'progress', step: { kind: 'search', query: CANARY } });
          const args = job.server([]).args;
          t.c.roadmap = { course: args[args.indexOf('--course') + 1]!, goal: 'React', track: 'react@1', style: 'io', concepts: [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }] };
          return {};
        },
      },
      { docker: { install: () => void docker.push('install'), open: async () => void docker.push('open') } },
    );
    const activity = await practising(t);
    // The first lesson has an example, so Run on it takes its success path.
    Object.assign(t.c.lessons.find((l) => l.id === 'values-1')!, { examples: [{ 'main.c': 'int main(void) { return 0; }' }], style: 'io' });
    // What the renderer hears without asking: check, job and Run events.
    const heard: unknown[] = [];
    const jobs: JobProgress[] = [];
    t.api.onCheckProgress((p) => heard.push(p));
    t.api.onJobProgress((p) => (heard.push(p), jobs.push(p)));
    t.api.onRunOutput((o) => heard.push(o));
    const call = async (method: Method, args: unknown[]) => {
      try {
        return JSON.stringify(await dispatch(t.api, method, args)) ?? '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const concepts = [{ id: 'values', title: 'Values', requires: [] }];
    const roadmap = (await t.api.research({ topic: 'React', known: '', depth: 'standard' })).roadmap;
    // Every method dispatch takes, in this order: the type makes a new IPC method fail to compile until it's here.
    const calls: Record<Method, unknown[]> = {
      agents: [],
      jobProgress: [],
      connect: ['claude'],
      chooseModel: ['claude', 'opus'],
      installAgent: ['cursor'],
      signIn: ['claude'],
      computer: [],
      installDocker: [],
      openDocker: [],
      tracks: [],
      course: [],
      draft: [],
      lesson: ['values-1'],
      saveNotes: ['values-1', 'my note'],
      markRead: ['values-1'],
      activity: ['values'],
      tryIt: [activity.id, 'canary-run'],
      check: [activity.id, 'canary-run'],
      runExample: ['values-1', 1],
      // Started, then fed and stopped by the calls after them.
      runProgram: [activity.id, 'canary-program'],
      runExampleLive: ['values-1', 1, 'canary-example'],
      sendRunInput: ['canary-program', 'Ada\n'],
      stopRun: ['canary-example'],
      ask: [{ activityId: activity.id }, 'Just fix it for me.'],
      saveFile: [activity.id, 'main.c', 'x', activity.files[0].digest],
      install: ['a'.repeat(64)],
      retrySetup: [],
      retryJobs: [],
      skip: ['values'],
      rebuild: ['react@1'],
      reviseRoadmap: [roadmap?.concepts ?? concepts, 'Add testing'],
      easier: ['state'],
      saveDraft: [concepts],
      approve: [concepts],
      research: [{ topic: 'React', known: '', depth: 'standard' }],
    };
    const payloads = [await call('ask', [{ lessonId: 'values-1' }, 'Why?'])];
    const results: Partial<Record<Method, string>> = {};
    const running: Promise<string>[] = [];
    for (const [method, args] of Object.entries(calls) as [Method, unknown[]][]) {
      const result = call(method, args).then((r) => (results[method] = r));
      if (method === 'runProgram' || method === 'runExampleLive') running.push(result);
      else payloads.push(await result);
      // Input sent before the program starts would go nowhere.
      if (method === 'runProgram') await vi.waitFor(() => expect(heard).toContainEqual({ run: 'canary-program', started: 'run', limitMs: expect.any(Number) }));
    }
    payloads.push(...(await Promise.all(running)));
    // The last research call started a job; wait for it, so its progress is heard.
    await settle(() => t.api.research({ topic: 'React', known: '', depth: 'standard' }), (r) => r.state !== 'running', 'Research');
    payloads.push(JSON.stringify(heard));

    // Each path really ran, so its success payload was checked, not only an error.
    expect(results.runExample).toMatch(/"kind":"ran"/);
    expect(results.runProgram).toMatch(/"kind":"ran","exit":0/);
    expect(results.sendRunInput).toBe('true');
    expect(results.runExampleLive).toMatch(/"stopped":true/);
    expect(heard).toContainEqual({ run: 'canary-program', stream: 'stdout', text: 'hello Ada\n' });
    expect(heard).toContainEqual({ run: 'canary-example', started: 'run', limitMs: expect.any(Number) });
    expect(jobs.some((p) => p.kind === 'research' && p.steps.some((s) => s.kind === 'search' && s.query === 'react hooks'))).toBe(true);
    // The tutor's own searches and pages never reached the window.
    expect(jobs.some((p) => p.kind === 'tutor')).toBe(true);
    expect(jobs.filter((p) => p.kind !== 'research').every((p) => p.steps.every((s) => s.kind === 'step'))).toBe(true);
    expect(docker).toEqual(['install', 'open']);

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
