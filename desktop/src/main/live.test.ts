// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGED, PLAN_LIMIT, REPAIR, UNSTOPPABLE } from '../shared/api';
import { CANARY, live, practising, researched, until } from './testing/fakes';
import { HELD_BACK } from './views';

describe('live CodemmApi', () => {
  it('needs a connected agent before research', async () => {
    const t = live();
    await expect(t.api.research({ topic: 'React', known: '', depth: 'standard' })).rejects.toThrow('codemm:no-agent');
  });

  it('researches a new course on a server bound to it, then shows the roadmap', async () => {
    const t = live();
    const r = await researched(t);
    expect(r).toEqual({ state: 'done', roadmap: { goal: 'React', track: 'react', installed: false, concepts: [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }] } });
    const job = t.jobs.ran[0];
    const course = t.c.roadmap!.course;
    expect(course).toMatch(/^react-[a-z0-9]+$/);
    expect(job.server(['list_tracks', 'save_roadmap']).args).toEqual(['core/cli.mjs', 'mcp', '--course', course, '--tools', 'list_tracks,save_roadmap']);
    expect(job.brief).toContain(`Course id: ${course}`);
  });

  it('runs every job with the chosen model: the recommended one until the learner picks another', async () => {
    const t = live();
    await researched(t);
    expect(t.jobs.ran.map((j) => j.model)).toEqual(['sonnet']);
    await t.api.chooseModel('claude', 'haiku');
    await t.api.reviseRoadmap(t.c.roadmap!.concepts, 'Add testing');
    expect(t.jobs.ran.map((j) => j.model)).toEqual(['sonnet', 'haiku']);
  });

  it('forwards check progress to listeners, counts only, until they stop listening', async () => {
    const t = live();
    const { id } = await practising(t);
    const seen: unknown[] = [];
    const off = t.api.onCheckProgress((p) => seen.push(p));
    await t.api.tryIt(id, 'run-1');
    await t.api.check(id, 'run-2');
    expect(seen).toEqual([
      { run: 'run-1', phase: 'visible', done: 1, total: 1 },
      { run: 'run-2', phase: 'visible', done: 1, total: 1 },
      { run: 'run-2', phase: 'hidden', done: 1, total: 2 },
    ]);
    off();
    await t.api.check(id, 'run-3');
    expect(seen).toHaveLength(3);
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
    // The failed view keeps the approved proposal, so Try again builds the same files.
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'offline', proposal: { digest: proposal!.digest } });
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

  it('starts no setup or lesson before the learner approves the roadmap', async () => {
    const t = live();
    await researched(t);
    expect(await t.api.course()).toBeNull();
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['research']);
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

  it('keeps the first stall, and launches no queued background work after it', async () => {
    const t = live({ setup: () => ({ ok: false, problem: 'plan-limit' }), lesson: () => ({ ok: false, problem: 'failed' }) });
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    await until(t.api, (c) => c.stalled !== undefined && t.jobs.ran.some((j) => j.kind === 'lesson'));
    await new Promise((res) => setTimeout(res, 20));
    expect((await t.api.course())!.stalled).toBe('plan-limit');
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')).toHaveLength(1);
  });

  it('holds back a roadmap reply that quotes hidden material', async () => {
    const t = live({ roadmap: () => ({ text: [`Here: ${CANARY}`] }) });
    await practising(t);
    const r = (await t.api.course())!;
    const change = await t.api.reviseRoadmap(r.topics.map((x) => ({ id: x.id, title: x.title, requires: x.id === 'state' ? ['values'] : [] })), 'Why?');
    expect(change.text).toBe(HELD_BACK);
  });

  it('a Docker failure during setup keeps the proposal, and Docker stopping during a Check is not counted', async () => {
    const t = live();
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    const install = t.c.install;
    t.c.install = async () => {
      throw new Error("The container runtime isn't running. Start Docker Desktop, then retry.");
    };
    await t.api.install(proposal!.digest);
    expect(await until(t.api, (c) => c.setup === 'failed')).toMatchObject({ setupProblem: 'docker', proposal: { digest: proposal!.digest } });
    t.c.install = install;
    await t.api.install(proposal!.digest);
    await until(t.api, (c) => c.setup === 'ready');

    const s = live();
    const activity = await practising(s);
    s.app.checkExercise = async () => {
      throw new Error("The container runtime stopped during the run, so it wasn't counted. Start Docker Desktop.");
    };
    expect(await s.api.check(activity.id)).toEqual({ kind: 'not-counted', reason: "Docker isn't running." });
  });

  it('keeps a stuck activity open beside the ways forward', async () => {
    const t = live();
    const activity = await practising(t);
    t.c.stuck = 'values';
    expect((await t.api.course())!.topics[0]).toMatchObject({ state: 'now', stuck: true, activity: 'open' });
    expect((await t.api.activity('values')).id).toBe(activity.id);
  });

  it('starts writing a review exercise when a review comes due while the app is open', async () => {
    const t = live();
    await practising(t);
    t.c.mastered.add('values');
    const authors = () => t.jobs.ran.filter((j) => j.kind === 'author').length;
    const before = authors();
    t.c.reviewWithout = 'values';
    expect((await t.api.course())!.topics[0]).toMatchObject({ review: 'writing' });
    await until(t.api, () => authors() === before + 1);
  });

  it('reopens a mastered topic for its due review, on the exercise core names', async () => {
    const t = live();
    const activity = await practising(t);
    t.c.mastered.add('values');
    t.c.review = { concept: 'values', exercise: activity.id };
    expect((await t.api.course())!.topics[0]).toMatchObject({ state: 'mastered', review: 'due', activity: 'open' });
    expect((await t.api.activity('values')).id).toBe(activity.id);
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
    expect(change).toMatchObject({ changed: true, roadmap: { track: 'vue' } });
    expect(t.c.proposals.filter((p) => p.track === 'react@1')).toEqual([]);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
    expect(t.jobs.ran.filter((j) => j.kind === 'setup').at(-1)!.brief).toContain('vue@1');
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

  it('a proposal the learner already acted on counts as the setup job\'s work, even after its gates failed', async () => {
    let acted: () => void = () => {};
    const actedOn = new Promise<void>((r) => (acted = r));
    const t = live({
      setup: async () => {
        t.c.proposals.push({ track: 'react@1', digest: 'a'.repeat(64), created: new Date().toISOString(), files: { Dockerfile: 'FROM x' } });
        // The learner approves while the agent is still ending its turn, and the gates reject it.
        await actedOn;
        await new Promise((r) => setTimeout(r, 5));
        return {};
      },
    });
    t.c.install = async () => {
      acted();
      throw new Error('Gate 2 failed: the reference solution fails its tests');
    };
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
    expect((await t.api.course())!.stalled).toBeUndefined();
    expect(t.jobs.ran.filter((j) => j.kind === 'setup')[1].brief).toContain('reference solution fails');
  });

  it('a Check or Try it started while Docker is starting waits for it first', async () => {
    let open: () => void = () => {};
    const started = new Promise<void>((r) => (open = r));
    let ready = async () => {};
    const t = live({}, { dockerReady: () => ready() });
    const activity = await practising(t);
    ready = () => started;
    const check = t.api.check(activity.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.c.checks).toEqual([]);
    open();
    await check;
    expect(t.c.checks).toEqual([activity.id]);
  });

  it("says Codemm's records need a repair, with core's guidance, when a record is damaged", async () => {
    const t = live();
    await practising(t);
    const guidance = "Codemm's record /h/courses/react/course.json is damaged. Restore it from a backup, or remove that track, course or exercise.";
    const damaged = Object.assign(new Error(guidance), { name: 'CodemmError' });
    t.app.progress = () => {
      throw damaged;
    };
    const failure = await t.api.course().catch((e: Error) => e);
    expect(failure).toMatchObject({ name: 'CodemmError', message: `${REPAIR}\n${guidance}` });
    t.app.progress = () => {
      throw Object.assign(new Error('The learning log /h/courses/react/events.jsonl has an invalid entry on line 3. Fix or remove that line, then retry.'), { name: 'CodemmError' });
    };
    await expect(t.api.check('values-easy-1')).rejects.toThrow(/^codemm:repair\nThe learning log/);
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

  it('after a gate failure, waits for the old proposal to go before asking for a new one', async () => {
    const t = live();
    const drop = t.app.dropProposal;
    // Deleting waits for the track lock.
    t.app.dropProposal = (ref) => new Promise((r) => setTimeout(() => r(drop(ref)), 30));
    t.c.install = async () => {
      throw new Error('Gate 2 failed: the reference solution fails its tests');
    };
    const r = await researched(t);
    await t.api.approve(r.roadmap!.concepts);
    const { proposal } = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(proposal!.digest);
    await until(t.api, () => t.jobs.ran.filter((j) => j.kind === 'setup').length === 2);
  });

  it('quitting waits for a Check that is waiting for Docker, and that Check then never runs', async () => {
    let open: () => void = () => {};
    const started = new Promise<void>((r) => (open = r));
    let ready = async () => {};
    const t = live({}, { dockerReady: () => ready() });
    const activity = await practising(t);
    ready = () => started;
    const check = t.api.check(activity.id).catch(() => 'not run');
    let stopped = false;
    const stopping = t.api.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    open();
    await Promise.all([check, stopping]);
    expect(t.c.checks).toEqual([]);
  });

  it('a damaged course record asks for a repair instead of looking like no course (D14)', async () => {
    const t = live();
    await practising(t);
    t.app.getRoadmap = () => {
      throw Object.assign(new Error("Codemm's record /h/courses/react/course.json is damaged. Restore it from a backup, or remove that track, course or exercise."), { name: 'CodemmError' });
    };
    await expect(t.api.course()).rejects.toThrow(/^codemm:repair\nCodemm's record/);
    t.app.getRoadmap = () => {
      throw Object.assign(new Error('No course in this workspace yet. Ask your agent to plan a roadmap (save_roadmap).'), { name: 'CodemmError' });
    };
    expect(await t.api.course()).toBeNull();
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

describe('Docker Desktop for the learner (§6.1)', () => {
  it('installs and opens Docker through the installer, and logs the install', async () => {
    const calls: string[] = [];
    const t = live({}, { docker: { install: () => void calls.push('install'), open: async () => void calls.push('open') } });
    await t.api.installDocker();
    await t.api.openDocker();
    expect(calls).toEqual(['install', 'open']);
    expect(readFileSync(t.logFile, 'utf8')).toMatch(/ docker-install\n/);
  });
});
