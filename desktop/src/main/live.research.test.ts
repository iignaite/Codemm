// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { type JobProgress } from '../shared/api';
import { CANARY, live, practising, researched, until } from './testing/fakes';
import { HELD_BACK } from './views';

describe('live CodemmApi: research, roadmaps and drafts (§4.2, §4.9)', () => {
  it('needs a connected agent before research', async () => {
    const t = live();
    await expect(t.api.research({ topic: 'React', known: '', depth: 'standard' })).rejects.toThrow('codemm:no-agent');
  });

  it('researches a new course on a server bound to it, then shows the roadmap', async () => {
    const t = live();
    const r = await researched(t);
    expect(r).toEqual({ state: 'done', roadmap: { title: 'React', goal: 'React', track: 'React', installed: false, concepts: [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }], sources: [] } });
    const job = t.jobs.ran[0];
    const course = t.c.roadmap!.course;
    expect(course).toMatch(/^react-[a-z0-9]+$/);
    expect(job.server(['list_tracks', 'save_roadmap']).args).toEqual(['core/cli.mjs', 'mcp', '--course', course, '--tools', 'list_tracks,save_roadmap']);
    expect(job.brief).toContain(`Course id: ${course}`);
    // Agents that read config from their working directory get Codemm's own folder, never the workspace.
    expect([job.cwd, job.agentDir]).toEqual(['/Users/me/Codemm', '/userData/agents']);
  });

  it('reviews once on the same course after sources save, and stays running until review ends', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const t = live({
      research: (job, usual) => {
        job.onSource?.({ title: 'Guide', url: 'https://example.com/guide' });
        return usual();
      },
      review: async (job) => {
        expect(t.c.roadmap!.sources).toEqual([{ title: 'Guide', url: 'https://example.com/guide' }]);
        expect(job.server([]).args).toEqual(t.jobs.ran[0].server([]).args);
        expect(await job.done({ ok: false })).toBe(false);
        expect(await job.done({ ok: true })).toBe(true);
        await waiting;
        t.c.roadmap = { ...t.c.roadmap!, title: 'Reviewed course' };
        return {};
      },
    });
    await t.api.connect('claude');
    const goal = { topic: 'Systems', known: '', depth: 'standard' as const };
    expect(await t.api.research(goal)).toEqual({ state: 'running' });
    await vi.waitFor(() => expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'review']));
    expect(await t.api.research(goal)).toEqual({ state: 'running' });
    expect(await t.api.draft()).toBeNull();
    await expect(t.api.approve(t.c.roadmap!.concepts)).rejects.toThrow('still being checked');
    release();
    await vi.waitFor(async () => expect(await t.api.research(goal)).toMatchObject({ state: 'done', roadmap: { title: 'Reviewed course' } }));
    expect(await t.api.draft()).toMatchObject({ title: 'Reviewed course' });
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'review']);
  });

  it.each(['failed', 'no save', 'throws'])('keeps successful research when review %s', async (failure) => {
    const log = vi.fn();
    const t = live({ review: () => {
      if (failure === 'throws') throw new Error('Review failed');
      return failure === 'no save' ? {} : { ok: false, problem: 'failed' };
    } }, { log });
    const r = await researched(t);
    expect(r).toMatchObject({ state: 'done', roadmap: { title: 'React' } });
    expect(await t.api.draft()).toMatchObject({ title: 'React' });
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research', 'review']);
    expect(log.mock.calls.some(([event]) => event === 'review-error' || event === 'review-no-change')).toBe(true);
  });

  it('does not review failed research', async () => {
    const t = live({ research: () => ({ ok: false, problem: 'failed' }) });
    expect(await researched(t)).toEqual({ state: 'failed' });
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research']);
  });

  it('stops a running review when quitting', async () => {
    const t = live({ review: (job) => new Promise((resolve) => {
      job.signal!.addEventListener('abort', () => resolve({ ok: false, problem: 'failed' }), { once: true });
    }) });
    await t.api.connect('claude');
    await t.api.research({ topic: 'Systems', known: '', depth: 'standard' });
    await vi.waitFor(() => expect(t.jobs.ran.at(-1)?.kind).toBe('review'));
    await t.api.stop();
    expect(t.jobs.ran.at(-1)!.signal!.aborted).toBe(true);
  });

  it.each(['approve', 'saveDraft', 'reviseRoadmap'] as const)('keeps concept metadata by id through %s', async (method) => {
    const t = live();
    await researched(t);
    const fields = { practice: 'Fix a loop', pitfalls: ['No budget'], refs: [0] };
    t.c.roadmap!.concepts[0] = { ...t.c.roadmap!.concepts[0], ...fields };
    t.c.roadmap!.sources = [{ title: 'Guide', url: 'https://example.com/guide' }];
    const concepts = [{ id: 'state', title: 'First', requires: [] }, { id: 'values', title: 'Renamed', requires: ['state'] }, { id: 'new', title: 'New', requires: [] }];
    if (method === 'reviseRoadmap') await t.api.reviseRoadmap(concepts, 'Add testing');
    else await t.api[method](concepts);
    expect(t.c.roadmap!.concepts.slice(0, 3)).toEqual([concepts[0], { ...concepts[1], ...fields }, concepts[2]]);
    await t.api.stop();
  });

  it('keeps the approved course while a new roadmap is a draft, and offers the draft to resume', async () => {
    const t = live();
    const { id } = await practising(t);
    const approved = t.c.roadmap!.course;
    let r = await t.api.research({ topic: 'Vue', known: '', depth: 'standard' });
    for (let i = 0; i < 20 && r.state === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 5));
      r = await t.api.research({ topic: 'Vue', known: '', depth: 'standard' });
    }
    const draft = t.c.roadmap!.course;
    expect(draft).not.toBe(approved);
    expect(await t.api.course()).toMatchObject({ topics: [{ id: 'values', state: 'now', activity: 'open' }, {}] });
    expect(await t.api.draft()).toMatchObject({ goal: 'Vue', concepts: [{ id: 'vue-values' }, { id: 'vue-state' }] });
    // Every learner call stays on the approved course.
    t.c.bound.length = 0;
    await t.api.activity('values');
    await t.api.tryIt(id, 'run-1');
    await t.api.check(id, 'run-2');
    await t.api.saveNotes('values-1', 'mine');
    await t.api.lesson('values-1');
    await t.api.ask({ activityId: id }, 'Why?');
    await t.api.easier('values');
    await t.api.skip('values');
    expect(t.c.bound.length).toBeGreaterThan(0);
    expect(t.c.bound.every((b) => b === approved)).toBe(true);
    expect(t.c.courses.get(approved)!.concepts.map((c) => c.id)).toContain('testing');
    expect(t.c.courses.get(draft)!.concepts.map((c) => c.id)).toEqual(['vue-values', 'vue-state']);
    // Edits to the draft are saved as they happen.
    await t.api.saveDraft([{ id: 'vue-state', title: 'State', requires: [] }, { id: 'vue-values', title: 'Values', requires: [] }]);
    expect((await t.api.draft())!.concepts.map((c) => c.id)).toEqual(['vue-state', 'vue-values']);
    await t.api.approve((await t.api.draft())!.concepts);
    expect(await t.api.draft()).toBeNull();
    expect(t.c.bound.at(-1)).toBe(draft);
  });

  it('has no draft to resume once the roadmap is approved', async () => {
    const t = live();
    expect(await t.api.draft()).toBeNull();
    const r = await researched(t);
    expect(await t.api.draft()).toMatchObject({ goal: 'React' });
    await t.api.approve(r.roadmap!.concepts);
    expect(await t.api.draft()).toBeNull();
    await expect(t.api.saveDraft(r.roadmap!.concepts)).rejects.toThrow('No roadmap to edit.');
  });

  it('saves edits, then asks for changes', async () => {
    const t = live();
    const r = await researched(t);
    const change = await t.api.reviseRoadmap([...r.roadmap!.concepts].reverse(), 'Add testing');
    expect(change.changed).toBe(true);
    expect(change.roadmap.concepts.map((c) => c.id)).toEqual(['state', 'values', 'testing']);
  });

  it('holds back a roadmap reply that quotes hidden material', async () => {
    const t = live({ roadmap: () => ({ text: [`Here: ${CANARY}`] }) });
    await practising(t);
    const r = (await t.api.course())!;
    const change = await t.api.reviseRoadmap(r.topics.map((x) => ({ id: x.id, title: x.title, requires: x.id === 'state' ? ['values'] : [] })), 'Why?');
    expect(change.text).toBe(HELD_BACK);
  });

  it("shows the roadmap's https sources, and keeps them through the learner's own edits", async () => {
    const t = live({
      research: (job) => {
        const args = job.server([]).args;
        t.c.roadmap = {
          course: args[args.indexOf('--course') + 1], goal: 'React', track: 'react@1', style: 'io',
          concepts: [{ id: 'values', title: 'Values', requires: [] }],
          sources: [{ title: 'React docs', url: 'https://react.dev/learn' }, { title: 'Not https', url: 'http://example.com' }],
        };
        return {};
      },
    });
    const r = await researched(t);
    expect(r.roadmap!.sources).toEqual([{ title: 'React docs', url: 'https://react.dev/learn' }]);
    await t.api.approve([...r.roadmap!.concepts, { id: 'hooks', title: 'Hooks', requires: [] }]);
    expect(t.c.roadmap!.sources).toEqual([{ title: 'React docs', url: 'https://react.dev/learn' }, { title: 'Not https', url: 'http://example.com' }]);
  });

  it('starts no second research while the first saves its sources', async () => {
    const t = live({
      research: (job) => {
        job.onSource?.({ title: 'roadmap.sh/react', url: 'https://roadmap.sh/react' });
        const args = job.server([]).args;
        t.c.roadmap = { course: args[args.indexOf('--course') + 1], goal: 'React', track: 'react@1', style: 'io', concepts: [{ id: 'values', title: 'Values', requires: [] }] };
        return {};
      },
    });
    const save = t.app.saveRoadmap;
    let release: () => void = () => undefined;
    t.app.saveRoadmap = async (...args) => {
      await new Promise<void>((r) => (release = r));
      return save(...args);
    };
    await t.api.connect('claude');
    const goal = { topic: 'React', known: '', depth: 'standard' as const };
    await t.api.research(goal);
    await new Promise((r) => setTimeout(r, 20));
    expect(await t.api.research(goal)).toEqual({ state: 'running' });
    // Quitting waits for the save.
    let stopped = false;
    const stopping = t.api.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research']);
    expect(t.c.roadmap!.sources).toEqual([{ title: 'roadmap.sh/react', url: 'https://roadmap.sh/react' }]);
  });

  it('holds back research progress that shows hidden material, and caps source titles', async () => {
    const t = live({
      research: (job) => {
        job.onEvent?.({ type: 'progress', step: { kind: 'search', query: `look up ${CANARY}` } });
        job.onSource?.({ title: 'x'.repeat(200), url: 'https://example.com/long' });
        const args = job.server([]).args;
        t.c.roadmap = { course: args[args.indexOf('--course') + 1], goal: 'React', track: 'react@1', style: 'io', concepts: [{ id: 'values', title: 'Values', requires: [] }] };
        return {};
      },
    });
    t.c.current = 'solved';
    const heard: unknown[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    expect(JSON.stringify(heard)).not.toContain(CANARY);
    expect(r.roadmap!.sources[0]!.title).toHaveLength(120);
  });

  it('forwards what research looks at, then adds the pages it read to the roadmap sources', async () => {
    const t = live({
      research: (job) => {
        job.onEvent?.({ type: 'progress', step: { kind: 'search', query: 'react roadmap 2026' } });
        job.onEvent?.({ type: 'progress', step: { kind: 'read', url: 'roadmap.sh/react', href: 'https://roadmap.sh/react' } });
        job.onSource?.({ title: 'roadmap.sh/react', url: 'https://roadmap.sh/react' });
        job.onEvent?.({ type: 'progress', step: { kind: 'read', url: 'react.dev/learn', href: 'https://react.dev/learn' } });
        job.onSource?.({ title: 'react.dev/learn', url: 'https://react.dev/learn' });
        const args = job.server([]).args;
        t.c.roadmap = {
          course: args[args.indexOf('--course') + 1], goal: 'React', track: 'react@1', style: 'io',
          concepts: [{ id: 'values', title: 'Values', requires: [] }], sources: [{ title: 'React docs', url: 'https://react.dev/learn' }],
        };
        return {};
      },
    });
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    const research = heard.filter((p) => p.kind === 'research');
    expect(research.map((p) => p.kind)).toEqual(['research', 'research', 'research', 'research', 'research']);
    expect(research.at(-2)!.steps).toEqual([{ kind: 'read', url: 'react.dev/learn' }, { kind: 'read', url: 'roadmap.sh/react' }, { kind: 'search', query: 'react roadmap 2026' }]);
    expect(research.at(-1)).toMatchObject({ ended: true, stage: 1, count: 3 });
    // The agent's own source comes first; a page it read only once joins it.
    expect(r.roadmap!.sources).toEqual([{ title: 'React docs', url: 'https://react.dev/learn' }, { title: 'roadmap.sh/react', url: 'https://roadmap.sh/react' }]);
  });

  it("drops the old track's proposals when a roadmap change moves the course to another track", async () => {
    const t = live({
      roadmap: () => {
        t.c.roadmap = { ...t.c.roadmap!, track: 'vue@1' };
        return { text: ['Vue fits better.'] };
      },
    });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.setup === 'consent');
    const change = await t.api.reviseRoadmap(r.roadmap!.concepts, 'Use Vue');
    expect(change).toMatchObject({ changed: true, roadmap: { track: 'Vue' } });
    expect(t.c.proposals.filter((p) => p.track === 'react@1')).toEqual([]);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
    expect(t.jobs.ran.filter((j) => j.kind === 'setup').at(-1)!.brief).toContain('vue@1');
  });
});
