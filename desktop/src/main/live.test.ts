// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CHANGED, PLAN_LIMIT } from '../shared/api';
import { CANARY, live, practising, researched, until } from './testing/fakes';
import { HELD_BACK } from './views';

describe('live CodemmApi', () => {
  it('needs a connected agent before research', async () => {
    const t = live();
    await expect(t.api.research({ topic: 'React', known: '' })).rejects.toThrow('codemm:no-agent');
  });

  it('researches with the job tools on a server bound to no course yet, then shows the roadmap', async () => {
    const t = live();
    const r = await researched(t);
    expect(r).toEqual({ state: 'done', roadmap: { goal: 'React', track: 'react', installed: false, concepts: [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }] } });
    const job = t.jobs.ran[0];
    expect(job.server(['list_tracks', 'save_roadmap']).args).toEqual(['core/cli.mjs', 'mcp', '--tools', 'list_tracks,save_roadmap']);
    expect(job.brief).toContain('React');
  });

  it('saves edits, then asks for changes', async () => {
    const t = live();
    const r = await researched(t);
    const change = await t.api.reviseRoadmap([...r.roadmap!.concepts].reverse(), 'Add testing');
    expect(change.changed).toBe(true);
    expect(change.roadmap.concepts.map((c) => c.id)).toEqual(['state', 'values', 'testing']);
  });

  it('proposes setup, builds only the proposal the learner saw, then writes lessons and an activity', async () => {
    const t = live();
    const activity = await practising(t);
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'setup', 'lesson', 'author']);
    expect(activity).toMatchObject({ id: 'values-easy-1', concept: 'values', title: 'Count up', statement: 'Print one.' });
    expect(JSON.stringify(activity)).not.toContain('/Users/me');
  });

  it('refuses to build a proposal the learner did not see', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.setup === 'consent');
    await expect(t.api.install('b'.repeat(64))).rejects.toThrow('The setup changed');
  });

  it('records nothing and retries the same proposal when setup fails offline or on low disk', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    const install = t.c.install;
    t.c.install = async () => {
      throw new Error('Could not resolve host: registry.npmjs.org');
    };
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'offline' });
    t.c.install = install;
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'ready')).toMatchObject({ setup: 'ready' });
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')).toHaveLength(1);
  });

  it('asks for a new proposal after the gates fail', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    t.c.install = async () => {
      throw new Error('Gate 3 failed: the image has no test runner');
    };
    await t.api.install(proposal!.digest);
    const again = await until(t.api, (c) => c.setup === 'consent');
    expect(again.proposal!.retry).toBe(true);
    expect(t.jobs.ran.filter((j) => j.kind === 'setup').at(-1)!.brief).toContain('no test runner');
  });

  it('saves by digest, and maps a file changed outside Codemm to CHANGED', async () => {
    const t = live();
    const activity = await practising(t);
    const digest = await t.api.saveFile(activity.id, 'main.c', 'int main() { return count + 1; }', activity.files[0].digest);
    await expect(t.api.saveFile(activity.id, 'main.c', 'x', activity.files[0].digest)).rejects.toThrow(CHANGED);
    expect(digest).not.toBe(activity.files[0].digest);
  });

  it('Try it records nothing; Check grades with hidden results as statuses only', async () => {
    const t = live();
    const activity = await practising(t);
    expect(await t.api.tryIt(activity.id)).toMatchObject({ kind: 'ran', tests: [{ hidden: false, name: 'prints one' }] });
    expect(t.c.checks).toEqual([]);
    await t.api.saveFile(activity.id, 'main.c', 'count + 1', activity.files[0].digest);
    expect(await t.api.check(activity.id)).toMatchObject({ kind: 'graded', passed: 2, mastered: true, tests: [{ hidden: false }, { hidden: true, index: 1, status: 'pass' }] });
  });

  it('a Docker failure is not counted, for Check and for Try it', async () => {
    const t = live();
    const activity = await practising(t);
    t.c.down = true;
    expect(await t.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
    expect(await t.api.tryIt(activity.id)).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
    expect(t.c.checks).toEqual([]);
  });

  it('holds back a tutor reply that quotes hidden material, and resumes the tutor session', async () => {
    const t = live({ tutor: () => ({ text: [`Just write ${CANARY}`, 'Think about what changes.'], session: 'session-1' }) });
    const activity = await practising(t);
    const replies = await t.api.ask({ activityId: activity.id }, 'Just fix it for me.');
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }, { from: 'codemm', text: 'Think about what changes.' }]);
    await t.api.ask({ activityId: activity.id }, 'Why?');
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor').map((j) => j.resume)).toEqual([undefined, 'session-1']);
  });

  it('turns a plan limit or a sign-out into its code, and stalls background work instead of relaunching it', async () => {
    const t = live({ tutor: () => ({ ok: false, problem: 'plan-limit' }) });
    const activity = await practising(t);
    await expect(t.api.ask({ activityId: activity.id }, 'Why?')).rejects.toThrow(PLAN_LIMIT);

    const s = live({ lesson: () => ({ ok: false, problem: 'signed-out' }) });
    const r = await researched(s);
    await s.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(s.api, (c) => c.setup === 'consent');
    await s.api.install(proposal!.digest);
    expect(await until(s.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'signed-out' });
    await s.api.course();
    expect(s.jobs.ran.filter((j) => j.kind === 'lesson')).toHaveLength(1);
    await s.api.retryJobs();
    await s.api.course();
    expect(s.jobs.ran.filter((j) => j.kind === 'lesson')).toHaveLength(2);
  });
});
