// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OFFLINE, PLAN_LIMIT, UNSTOPPABLE, type JobProgress } from '../shared/api';
import { CANARY, live, practising, researched, until } from './testing/fakes';
import { tempDir } from './testing/temp';
import { desktopState } from './state';
import { usageStore } from './usage';
import { HELD_BACK } from './views';

describe('live CodemmApi: agent jobs: models, lanes, stalls, the tutor, progress and quitting (§3.2, §4.11)', () => {
  it('runs every job with the chosen model: the recommended one until the learner picks another', async () => {
    const t = live();
    await researched(t);
    expect(t.jobs.ran.map((j) => j.model)).toEqual(['sonnet']);
    await t.api.chooseModel('claude', 'haiku');
    await t.api.reviseRoadmap(t.c.roadmap!.concepts, 'Add testing');
    expect(t.jobs.ran.map((j) => j.model)).toEqual(['sonnet', 'haiku']);
  });

  it("records what each job's agent reported, under its course and kind, for the course on screen", async () => {
    const usage = usageStore(tempDir('codemm-usage-'));
    const t = live(
      {
        tutor: (job) => {
          job.onUsage?.({ input: 100, output: 10, cachedInput: 50, costUsd: 0.2, session: 's9' });
          return { ok: true, text: ['Look at line 3.'], session: 's9' };
        },
      },
      { usage },
    );
    expect(await t.api.usage()).toBeNull();
    const { id } = await practising(t);
    await t.api.ask({ activityId: id }, 'Why?');
    const shown = await t.api.usage();
    expect(shown).toMatchObject({ kinds: { tutor: { input: 100, output: 10, cachedInput: 50, costUsd: 0.2, runs: 1 } } });
    expect(shown!.total.runs).toBe(1);
    // Researching a new roadmap makes it the workspace's draft; the approved course, the one on screen, keeps its usage.
    const onScreen = t.c.roadmap!.course;
    const goal = { topic: 'Python', known: '', depth: 'standard' } as const;
    let r = await t.api.research(goal);
    for (let i = 0; i < 20 && r.state === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 5));
      r = await t.api.research(goal);
    }
    expect(t.c.roadmap!.course).not.toBe(onScreen);
    expect((await t.api.usage())!.total.runs).toBe(1);
  });

  it("gives every job core's abandoned-container cleanup, for an attempt Codemm ends", async () => {
    const t = live();
    await researched(t);
    const before = t.c.cleanups;
    await t.jobs.ran[0].cleanup?.();
    expect(t.c.cleanups).toBe(before + 1);
  });

  it("holds back every tutor reply when the exercise's hidden material can't be loaded", async () => {
    const t = live({ tutor: () => ({ text: [`Just write ${CANARY}`, 'Think about what changes.'] }) });
    const activity = await practising(t);
    t.app.hiddenMaterial = () => {
      throw new Error('EIO: hidden material unreadable');
    };
    const replies = await t.api.ask({ activityId: activity.id }, 'Just fix it for me.');
    // Without the material there's nothing to check a reply against, so nothing goes out.
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }, { from: 'codemm', text: HELD_BACK }]);
  });

  it("filters a tutor reply against the turn's own course, even if another course is approved while it runs", async () => {
    let approveOther = () => undefined as void;
    const t = live({
      tutor: () => {
        approveOther();
        return { text: [`Just write ${CANARY}`] };
      },
    });
    const activity = await practising(t);
    const course = t.c.roadmap!.course;
    const material = t.app.hiddenMaterial;
    // Only the turn's course has this hidden material; the other course has none.
    t.app.hiddenMaterial = (c, slug) => (c === course ? material(c, slug) : []);
    approveOther = () => void desktopState(t.dir).update((s) => ({ ...s, approved: 'another-course' }));
    const replies = await t.api.ask({ activityId: activity.id }, 'Just fix it for me.');
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }]);
  });

  it('checks a lesson question\'s reply against an exercise the tutor opened during the turn', async () => {
    let t!: ReturnType<typeof live>;
    t = live({
      tutor: () => {
        // The tutor calls get_exercise, which makes that exercise current.
        t.c.current = [...t.c.exercises.keys()][0];
        return { text: [`Look: ${CANARY}`] };
      },
    });
    // Practising, up to the open activity, but without opening it: no exercise is current when the turn starts.
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const consent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(consent.proposal!.digest);
    const course = await until(t.api, (c) => c.setup === 'ready' && c.topics[0].lessons.some((l) => l.state === 'ready'));
    for (const l of course.topics[0].lessons) if (l.state === 'ready') await t.api.markRead(l.id);
    await until(t.api, (c) => c.topics[0].activity === 'open');
    t.c.current = undefined;
    const replies = await t.api.ask({ lessonId: course.topics[0].lessons[0].id }, 'Show me the answer.');
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }]);
  });

  it("checks a lesson question's reply against every exercise of the course, even while a draft roadmap is active", async () => {
    const t = live({ tutor: () => ({ text: [`Look: ${CANARY}`] }) });
    // Practising, up to the open activity, but without opening it.
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const consent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(consent.proposal!.digest);
    const course = await until(t.api, (c) => c.setup === 'ready' && c.topics[0].lessons.some((l) => l.state === 'ready'));
    for (const l of course.topics[0].lessons) if (l.state === 'ready') await t.api.markRead(l.id);
    await until(t.api, (c) => c.topics[0].activity === 'open');
    // A new roadmap is researched: the workspace now belongs to that draft, with no current exercise.
    const goal = { topic: 'Vue', known: '', depth: 'standard' } as const;
    let next = await t.api.research(goal);
    for (let i = 0; i < 20 && next.state === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 5));
      next = await t.api.research(goal);
    }
    t.c.current = undefined;
    const replies = await t.api.ask({ lessonId: course.topics[0].lessons[0].id }, 'Show me the answer.');
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }]);
  });

  it('checks a roadmap-change reply against an exercise saved while the change ran', async () => {
    const t = live({
      roadmap: () => {
        // The approved course's background author finishes an exercise while the change runs.
        t.c.exercises.set('values-late-1', { concept: 'values', file: '', digest: '0'.repeat(64), created: new Date().toISOString() });
        return { text: [`Quoting it: ${CANARY}`] };
      },
    });
    await practising(t);
    const material = t.app.hiddenMaterial;
    // Only the exercise saved during the change has this hidden material.
    t.app.hiddenMaterial = (c, slug) => (slug === 'values-late-1' ? material(c, slug) : []);
    const change = await t.api.reviseRoadmap(t.c.roadmap!.concepts, 'Add testing');
    expect(change.text).toBe(HELD_BACK);
  });

  it('drops a roadmap source whose title or link quotes hidden material', async () => {
    const t = live({
      roadmap: (job) => {
        const args = job.server([]).args;
        t.c.courses.get(args[args.indexOf('--course') + 1])!.sources = [
          { title: `Notes: ${CANARY}`, url: 'https://notes.example/a' },
          { title: 'React docs', url: 'https://react.dev/learn' },
        ];
        return { text: ['Added a source.'] };
      },
    });
    await practising(t);
    const change = await t.api.reviseRoadmap(t.c.roadmap!.concepts, 'Add a source');
    expect(change.roadmap.sources).toEqual([{ title: 'React docs', url: 'https://react.dev/learn' }]);
    expect(JSON.stringify(change)).not.toContain('CANARY');
  });

  it('holds back a tutor reply that quotes hidden material, and resumes the tutor session', async () => {
    const t = live({ tutor: () => ({ text: [`Just write ${CANARY}`, 'Think about what changes.'], session: 'session-1' }) });
    const activity = await practising(t);
    const replies = await t.api.ask({ activityId: activity.id }, 'Just fix it for me.');
    expect(replies).toEqual([{ from: 'codemm', text: HELD_BACK }, { from: 'codemm', text: 'Think about what changes.' }]);
    await t.api.ask({ activityId: activity.id }, 'Why?');
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor').map((j) => j.resume)).toEqual([undefined, 'session-1']);
    expect(t.jobs.ran.find((j) => j.kind === 'tutor')!.brief).toContain('int main() { /* yours */ }');
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
    await until(s.api, () => s.jobs.ran.filter((j) => j.kind === 'lesson').length === 2);
  });

  it('writes the first lesson in the foreground while setup runs, on servers bound to the course', async () => {
    const t = live({ setup: () => new Promise(() => {}) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const course = await until(t.api, (c) => c.topics[0].lessons.some((l) => l.state === 'ready'));
    expect(course).toMatchObject({ setup: 'proposing', topics: [{ id: 'values', state: 'now', activity: 'writing' }, {}] });
    for (const j of t.jobs.ran.filter((x) => x.kind !== 'research')) expect(j.server(['get_lesson']).args).toEqual(['core/cli.mjs', 'mcp', '--course', t.c.roadmap!.course, '--tools', 'get_lesson']);
    t.c.bound.length = 0;
    await t.api.course();
    expect(t.c.bound.every((b) => b === t.c.roadmap!.course)).toBe(true);
  });

  it('an offline job stalls background work as offline, and research says so', async () => {
    const t = live({ setup: () => ({ ok: false, problem: 'offline' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'offline' });

    const s = live({ research: () => ({ ok: false, problem: 'offline' }) });
    await expect(researched(s)).rejects.toThrow(OFFLINE);
  });

  it("a job Docker or the disk stopped stalls background work as this computer's problem, not the agent's", async () => {
    const t = live({ setup: () => ({ ok: false, problem: 'docker' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'docker' });

    const s = live({ setup: () => ({ ok: false, problem: 'disk' }) });
    const q = await researched(s);
    await s.api.approve(q.roadmap!.concepts);
    expect(await until(s.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'disk' });
  });

  it("a lesson that couldn't be written keeps its row, says so, and blames no agent", async () => {
    const t = live({ lesson: () => ({ ok: false, problem: 'failed' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    const course = await until(t.api, (c) => c.stalled !== undefined);
    expect(course.stalled).toBe('lesson');
    expect(course.topics.flatMap((topic) => topic.lessons)).toContainEqual(expect.objectContaining({ title: 'Lesson', state: 'failed' }));
    // Try again writes it again.
    await t.api.retryJobs();
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'lesson').length === 2);
  });

  it('a job that found its track image gone stalls as a rebuild, not as the agent failing', async () => {
    const t = live({ lesson: () => ({ ok: false, problem: 'rebuild' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'rebuild' });
  });

  it("a job Docker was too busy to answer stalls as busy, not stopped, and the log says which failure it was", async () => {
    const t = live({ setup: () => ({ ok: false, problem: 'docker-busy', cause: 'runtime-busy' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'docker-busy' });
    expect(readFileSync(t.logFile, 'utf8')).toMatch(/ job-end kind=setup ok=false problem=docker-busy cause=runtime-busy ms=\d+\n/);
  });

  it('keeps the first stall, and launches no queued background work after it', async () => {
    const t = live({ setup: () => ({ ok: false, problem: 'plan-limit' }), lesson: () => ({ ok: false, problem: 'failed' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.stalled !== undefined && t.jobs.ran.some((j) => j.kind === 'lesson'));
    await new Promise((res) => setTimeout(res, 20));
    expect((await t.api.course())!.stalled).toBe('plan-limit');
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')).toHaveLength(1);
  });

  it('tells every job kind\'s progress on one channel, with its topic, and lists the jobs running now (§4.11)', async () => {
    let during: JobProgress[] = [];
    const t = live({
      lesson: async (job) => {
        job.onEvent?.({ type: 'session', id: 's1' });
        job.onEvent?.({ type: 'tool_call', id: 'c1', name: 'codemm.save_lesson' });
        job.onEvent?.({ type: 'progress', step: { kind: 'step', label: 'Saving the lesson' } });
        during = await t.api.jobProgress();
        const concept = t.c.roadmap!.concepts[0].id;
        t.c.lessons.push({ id: `${concept}-1`, concept, title: 'About', markdown: '# About', notes: '' });
        return {};
      },
    });
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.topics[0].lessons.some((l) => l.state === 'ready'));
    const lesson = heard.filter((p) => p.kind === 'lesson');
    expect(lesson.map((p) => [p.stage, p.ended ?? false])).toEqual([[0, false], [1, false], [2, false], [2, false], [2, true]]);
    expect(lesson.every((p) => p.concept === 'values' && p.job === lesson[0].job)).toBe(true);
    expect(lesson.at(-1)!.steps).toEqual([{ kind: 'step', label: 'Saving the lesson' }]);
    expect(during.map((p) => p.kind)).toContain('lesson');
    expect((await t.api.jobProgress()).map((p) => p.kind)).not.toContain('lesson');
  });

  it("gives an author's server a gate file, and shows the gate it names during the save", async () => {
    const progressDir = mkdtempSync(join(tmpdir(), 'codemm-progress-'));
    const heard: JobProgress[] = [];
    const t = live({
      author: async (job) => {
        const args = job.server(['save_exercise']).args;
        const file = args[args.indexOf('--progress') + 1];
        job.onEvent?.({ type: 'tool_call', id: 'c1', name: 'codemm.save_exercise' });
        writeFileSync(file, JSON.stringify({ format_version: 1, gate: 'mutants' }));
        // Another tool's result during the save leaves its gate in place.
        job.onEvent?.({ type: 'tool_call', id: 'c0', name: 'codemm.next_step' });
        job.onEvent?.({ type: 'tool_result', id: 'c0', error: false });
        expect(existsSync(file)).toBe(true);
        await vi.waitFor(() => expect(heard.some((p) => p.part?.done === 3)).toBe(true), { timeout: 2000 });
        job.onEvent?.({ type: 'tool_result', id: 'c1', error: false });
        expect(existsSync(file)).toBe(false);
        const concept = t.c.roadmap!.concepts.find((x) => !t.c.mastered.has(x.id))!.id;
        t.c.exercises.set(`${concept}-easy-1`, { concept, file: 'int main() {}', digest: '0'.repeat(64), created: new Date().toISOString(), difficulty: t.c.writes });
        return {};
      },
    }, { progressDir });
    t.api.onJobProgress((p) => heard.push(p));
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const consent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(consent.proposal!.digest);
    await vi.waitFor(() => expect(heard.some((p) => p.kind === 'author' && p.ended)).toBe(true), { timeout: 4000 });
    const gate = heard.find((p) => p.part?.done === 3)!;
    expect(gate).toMatchObject({ kind: 'author', stage: 2, part: { done: 3, total: 3 } });
    expect(gate.steps[0]).toEqual({ kind: 'step', label: 'Codemm is checking that the tests catch each broken version' });
    // Other jobs' servers get no gate file.
    expect(t.jobs.ran.filter((j) => j.kind !== 'author').every((j) => !j.server([]).args.includes('--progress'))).toBe(true);
  });

  it('says when a failed job runs again', async () => {
    const t = live(undefined, {
      runJob: async (job) => {
        job.onRelaunch?.();
        return { ok: true, text: [] };
      },
    });
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    await t.api.connect('claude');
    await t.api.research({ topic: 'React', known: '', depth: 'standard' });
    await vi.waitFor(() => expect(heard.at(-1)?.ended).toBe(true));
    expect(heard[1]).toMatchObject({ kind: 'research', retry: { attempt: 2, of: 2 } });
  });

  it('connecting again ends a sign-out that stopped background work', async () => {
    const t = live({ lesson: () => ({ ok: false, problem: 'signed-out' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.stalled === 'signed-out');
    await t.api.connect('claude');
    expect((await t.api.course())!.stalled).toBeUndefined();
  });

  it('removes leftover containers on start, and on stop after every job and running Check, and starts nothing after', async () => {
    const t = live({ setup: (job) => new Promise((done) => job.signal!.addEventListener('abort', () => done({ ok: false, problem: 'failed' }))) });
    expect(t.c.cleanups).toBe(1);
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await t.api.course();

    let finish = () => {};
    const s = live();
    const a = await practising(s);
    s.app.checkExercise = () => new Promise((done) => (finish = () => done({ exercise: a.id, passed: 0, total: 0, recorded: true, tests: [] })));
    const check = s.api.check(a.id);
    // The Check is running when quitting starts.
    await new Promise((r) => setTimeout(r, 10));
    let stopped = false;
    const stopping = s.api.stop().then(() => (stopped = true));
    await new Promise((res) => setTimeout(res, 10));
    expect(stopped).toBe(false);
    finish();
    await Promise.all([check, stopping]);
    expect(s.c.cleanups).toBe(2);

    await t.api.stop();
    const ran = t.jobs.ran.length;
    await t.api.course();
    await new Promise((res) => setTimeout(res, 10));
    expect(t.jobs.ran).toHaveLength(ran);
  });

  it('reading the course, a lesson or an activity starts no agent: only Codemm\'s own steps do (D9)', async () => {
    const t = live();
    const activity = await practising(t);
    const lesson = (await t.api.course())!.topics[0].lessons[0].id;
    const ran = t.jobs.ran.length;
    // Work becomes due without any step of the learner's: a read must not start it.
    t.c.lessons.length = 0;
    t.c.exercises.clear();
    await t.api.course();
    await t.api.course();
    await t.api.lesson(lesson).catch(() => undefined);
    await t.api.activity(activity.concept).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.jobs.ran).toHaveLength(ran);
  });

  it('answers each of two questions asked at once, one turn after the other, resuming the session', async () => {
    let n = 0;
    const t = live({ tutor: (job) => ({ text: [`Answer to: ${job.brief.split('They ask: ')[1]}`], session: `session-${++n}` }) });
    const activity = await practising(t);
    const [first, second] = await Promise.all([t.api.ask({ activityId: activity.id }, 'Why one?'), t.api.ask({ activityId: activity.id }, 'Why two?')]);
    expect(first).toEqual([{ from: 'codemm', text: 'Answer to: Why one?' }]);
    expect(second).toEqual([{ from: 'codemm', text: 'Answer to: Why two?' }]);
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor').map((j) => j.resume)).toEqual([undefined, 'session-1']);
  });

  it('an author job is done only by a new exercise for the requested concept and difficulty', async () => {
    const t = live();
    t.c.wanted = 2;
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    // The author writes difficulty 1 when 2 was asked for: not done, so the work stalls instead of looping.
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'failed' });
    for (let i = 0; i < 3; i++) await t.api.course();
    expect(t.jobs.ran.filter((j) => j.kind === 'author')).toHaveLength(1);
  });

  it('an agent Codemm could not stop says so, in the foreground and as stalled background work', async () => {
    const t = live({ tutor: () => ({ ok: false, problem: 'unstoppable' }) });
    const activity = await practising(t);
    await expect(t.api.ask({ activityId: activity.id }, 'Why?')).rejects.toThrow(UNSTOPPABLE);

    const s = live({ lesson: () => ({ ok: false, problem: 'unstoppable' }) });
    const r = await researched(s);
    await s.api.approve(r.roadmap!.concepts);
    expect(await until(s.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'unstoppable' });
  });

  it('an infrastructure failure in background work is a recoverable stall', async () => {
    const t = live({ lesson: () => ({ ok: false, problem: 'infra' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    expect(await until(t.api, (c) => c.stalled !== undefined)).toMatchObject({ stalled: 'failed' });
  });

  it('starts no agent at all once one could not be stopped, until Codemm quits', async () => {
    const t = live({ tutor: () => ({ ok: false, problem: 'unstoppable' }) });
    const activity = await practising(t);
    await expect(t.api.ask({ activityId: activity.id }, 'Why?')).rejects.toThrow(UNSTOPPABLE);
    await expect(t.api.ask({ activityId: activity.id }, 'Why again?')).rejects.toThrow(UNSTOPPABLE);
    await t.api.retryJobs();
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor')).toHaveLength(1);
  });

  it('a job that was waiting for the agent lookup does not launch once another job turned out unstoppable', async () => {
    let release: () => void = () => {};
    const lookup = new Promise<void>((r) => (release = r));
    let unstoppable = false;
    const t = live({
      author: () => {
        if (unstoppable) return { ok: false, problem: 'unstoppable' };
        t.c.exercises.set('values-easy-1', { concept: 'values', file: 'int main() { /* yours */ }', digest: '0'.repeat(64), created: new Date().toISOString(), difficulty: 1 });
        return {};
      },
    });
    await practising(t);
    unstoppable = true;
    const chosen = t.connect.chosen.bind(t.connect);
    // The tutor turn waits in the agent lookup while a background author job finds its agent unstoppable.
    let calls = 0;
    t.connect.chosen = async () => {
      // ask() looks up the agent, then the job does again: hold the job's lookup.
      if (++calls === 2) await lookup;
      return chosen();
    };
    const lesson = (await t.api.course())!.topics[0].lessons[0].id;
    const ask = t.api.ask({ lessonId: lesson }, 'Why?').catch((e: Error) => e.message);
    await until(t.api, () => calls === 2);
    t.c.exercises.clear();
    await t.api.retryJobs();
    await until(t.api, (c) => c.stalled === 'unstoppable');
    release();
    expect(await ask).toContain('codemm:unstoppable');
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor')).toHaveLength(0);
  });
});
