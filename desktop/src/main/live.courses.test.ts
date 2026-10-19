// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { JobProgress } from '../shared/api';
import { desktopState } from './state';
import { boundOf, live, practising, settle, until } from './testing/fakes';

type Test = ReturnType<typeof live>;

/** Researches a goal and approves its roadmap: it becomes one of the learner's courses, on screen. */
async function approved(t: Test, topic: string): Promise<string> {
  await t.api.connect('claude');
  const goal = { topic, known: '', depth: 'standard' } as const;
  const r = await settle(() => t.api.research(goal), (x) => x.state !== 'running', 'Research');
  await t.api.approve(r.roadmap!.concepts);
  return t.c.roadmap!.course;
}

/** A promise a fake agent waits on until the test lets it go. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

const ran = (t: Test, kind: string) => t.jobs.ran.filter((j) => j.kind === kind).map(boundOf);
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('live CodemmApi: several courses (§4.13)', () => {
  it('keeps every approved course and binds learner calls to the one on screen', async () => {
    const t = live();
    const react = await approved(t, 'React');
    const python = await approved(t, 'Python');
    expect(await t.api.courses()).toEqual([
      { id: react, title: 'React', track: 'react', current: false },
      { id: python, title: 'Python', track: 'python', current: true },
    ]);
    expect((await t.api.course())!.goal).toBe('Python');
    await t.api.switchCourse(react);
    expect((await t.api.course())!.goal).toBe('React');
    expect((await t.api.courses()).map((c) => c.current)).toEqual([true, false]);
    // The newer course is the learner's, not a draft, though core's workspace still points at it.
    expect(await t.api.draft()).toBeNull();
    t.c.bound.length = 0;
    await t.api.skip('values');
    expect(t.c.bound.length).toBeGreaterThan(0);
    expect(t.c.bound.every((b) => b === react)).toBe(true);
    await expect(t.api.switchCourse('elsewhere')).rejects.toThrow();
    expect((await t.api.course())!.goal).toBe('React');
  });

  it("names a course by the words the learner typed, and keeps the agent's goal beside it (W-5)", async () => {
    const goal = 'Develop systematic thinking about React applications, from components to state';
    const t = live({ research: (_job, usual) => (usual(), (t.c.roadmap!.goal = goal), {}) });
    await t.api.connect('claude');
    const r = await settle(() => t.api.research({ topic: 'React', known: '', depth: 'standard' }), (x) => x.state !== 'running', 'Research');
    expect(r.roadmap).toMatchObject({ title: 'React', goal });
    expect(await t.api.draft()).toMatchObject({ title: 'React', goal });
    await t.api.approve(r.roadmap!.concepts);
    expect(await t.api.course()).toMatchObject({ title: 'React', goal });
    expect((await t.api.courses())[0].title).toBe('React');
    // A course from before names, or from the terminal, is named by its goal.
    desktopState(t.dir).update((s) => ({ ...s, names: {} }));
    expect((await t.api.course())!.title).toBe(goal);
  });

  it("stalls only the course whose background job failed, and Try again restarts only that course", async () => {
    const t = live({ setup: (job, usual) => (job.brief.includes('`react@1`') ? { ok: false, problem: 'docker' } : usual()) });
    const react = await approved(t, 'React');
    await until(t.api, (c) => c.stalled === 'docker');
    const python = await approved(t, 'Python');
    expect(await until(t.api, (c) => c.setup === 'consent')).not.toHaveProperty('stalled');
    await t.api.switchCourse(react);
    expect((await t.api.course())!.stalled).toBe('docker');
    await t.api.retryJobs();
    await settle(async () => ran(t, 'setup'), (r) => r.filter((c) => c === react).length === 2, "React's setup again");
    expect(ran(t, 'setup').filter((c) => c === python)).toHaveLength(1);
  });

  it("lets a course's setup run on after a switch, and never makes another course wait for it", async () => {
    const held = gate();
    const t = live({ setup: async (job, usual) => (job.brief.includes('`react@1`') && (await held.opened), usual()) });
    const react = await approved(t, 'React');
    await settle(async () => ran(t, 'setup'), (r) => r.includes(react), "React's setup");
    await approved(t, 'Python');
    // Python proposes while React's setup is still running.
    expect((await until(t.api, (c) => c.setup === 'consent')).goal).toBe('Python');
    held.open();
    await t.api.switchCourse(react);
    expect((await until(t.api, (c) => c.setup === 'consent')).proposal!.digest).toBe('a'.repeat(64));
  });

  it("finishes an off-screen course's install and starts the activity it makes due", async () => {
    const t = live();
    const built = gate();
    t.c.install = async (ref) => (await built.opened, t.c.tracks.push(ref), {});
    const react = await approved(t, 'React');
    const consent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(consent.proposal!.digest);
    await approved(t, 'Python');
    built.open();
    await settle(async () => ran(t, 'author'), (r) => r.includes(react), "React's activity");
  });

  it('builds one track at a time across courses', async () => {
    const t = live();
    const started: string[] = [];
    const builds: (() => void)[] = [];
    t.c.install = (ref) => (started.push(ref), new Promise((done) => builds.push(() => done(t.c.tracks.push(ref)))));
    const react = await approved(t, 'React');
    const reactConsent = await until(t.api, (c) => c.setup === 'consent');
    await approved(t, 'Python');
    const pythonConsent = await until(t.api, (c) => c.setup === 'consent');
    await t.api.install(pythonConsent.proposal!.digest);
    await t.api.switchCourse(react);
    await t.api.install(reactConsent.proposal!.digest);
    await settle(async () => started, (s) => s.length > 0, 'the first build');
    await pause();
    expect(started).toEqual(['python@1']);
    builds[0]();
    await settle(async () => started, (s) => s.length === 2, 'the second build');
    expect(started).toEqual(['python@1', 'react@1']);
  });

  it('runs one author job at a time across courses: its save builds and checks in containers', async () => {
    const held = gate();
    const t = live({ author: async (job, usual) => (boundOf(job).startsWith('react') && (await held.opened), usual()) });
    t.c.tracks.push('react@1', 'python@1');
    const react = await approved(t, 'React');
    await settle(async () => ran(t, 'author'), (r) => r.length === 1, "React's author");
    const python = await approved(t, 'Python');
    // Python's lesson is written meanwhile; its activity waits for React's author job.
    await settle(async () => ran(t, 'lesson'), (r) => r.includes(python), "Python's lesson");
    await pause();
    expect(ran(t, 'author')).toEqual([react]);
    held.open();
    await settle(async () => ran(t, 'author'), (r) => r.length === 2, "Python's author");
    expect(ran(t, 'author')).toEqual([react, python]);
  });

  it.each([
    ['still queued behind its own course', false],
    ["already waiting for the author turn", true],
  ])("stops a job waiting for another course's author turn at once: %s", async (_when, lessonDone) => {
    const held = gate();
    const t = live({ author: async (job, usual) => (boundOf(job).startsWith('react') && (await held.opened), usual()) });
    t.c.tracks.push('react@1', 'python@1');
    await approved(t, 'React');
    await settle(async () => ran(t, 'author'), (r) => r.length === 1, "React's author");
    const python = await approved(t, 'Python');
    await settle(async () => ran(t, 'lesson'), (r) => r.includes(python), "Python's lesson");
    if (lessonDone) await until(t.api, (c) => c.topics[0].lessons.some((l) => l.state === 'ready'));
    // Python's activity waits for React's author job. "Try an easier one" cancels it without waiting for that turn.
    const easier = t.api.easier('python-values').then(() => 'done');
    expect(await Promise.race([easier, pause(500).then(() => 'waiting')])).toBe('done');
    held.open();
  });

  it('saves a file to the course its activity was opened in, after a switch', async () => {
    const t = live();
    const activity = await practising(t);
    const react = t.c.roadmap!.course;
    await approved(t, 'Python');
    t.c.bound.length = 0;
    await t.api.saveFile(activity.id, activity.files[0].path, 'my edit', activity.files[0].digest);
    expect(t.c.bound).toEqual([react]);
  });

  it('shares one setup between courses on the same track: one proposal, one install', async () => {
    const held = gate();
    const t = live({ research: (_job, usual) => (usual(), (t.c.roadmap!.track = 'react@1'), {}), setup: async (_job, usual) => (await held.opened, usual()) });
    const react = await approved(t, 'React');
    await settle(async () => ran(t, 'setup'), (r) => r.length === 1, "React's setup");
    await approved(t, 'Vue');
    await pause();
    expect(ran(t, 'setup')).toHaveLength(1);
    held.open();
    const consent = await until(t.api, (c) => c.setup === 'consent');
    let installs = 0;
    const built = gate();
    t.c.install = async (ref) => (installs++, await built.opened, t.c.tracks.push(ref), {});
    await t.api.install(consent.proposal!.digest);
    await t.api.switchCourse(react);
    expect((await t.api.course())!.setup).toBe('installing');
    built.open();
    await until(t.api, (c) => c.setup === 'ready');
    expect(installs).toBe(1);
  });

  it('starts the next work of the course a check was in, though another is on screen by its end', async () => {
    const t = live();
    const activity = await practising(t);
    const react = t.c.roadmap!.course;
    await t.api.saveFile(activity.id, activity.files[0].path, 'count + 1', activity.files[0].digest);
    const graded = gate();
    const check = t.app.checkExercise;
    t.app.checkExercise = async (...args: Parameters<typeof check>) => (await graded.opened, check(...args));
    const checking = t.api.check(activity.id, 'run-1');
    await approved(t, 'Python');
    graded.open();
    await checking;
    await settle(async () => t.jobs.ran.filter((j) => j.kind === 'lesson' && boundOf(j) === react).length, (n) => n === 2, "React's next lesson");
  });

  it("resumes each course's own tutor session, and never makes a question wait for another course's turn", async () => {
    let held: ReturnType<typeof gate> | undefined;
    const t = live({
      tutor: async (job) => {
        if (held && boundOf(job).startsWith('react')) await held.opened;
        return { text: ['Think about it.'], session: `session-${boundOf(job)}` };
      },
    });
    const react = await approved(t, 'React');
    await t.api.ask({ lessonId: 'values-1' }, 'Why?');
    const python = await approved(t, 'Python');
    await t.api.ask({ lessonId: 'python-values-1' }, 'Why?');
    await t.api.switchCourse(react);
    await t.api.ask({ lessonId: 'values-1' }, 'And then?');
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor').map((j) => j.resume)).toEqual([undefined, undefined, `session-${react}`]);
    held = gate();
    const waiting = t.api.ask({ lessonId: 'values-1' }, 'Still there?');
    await t.api.switchCourse(python);
    expect(await t.api.ask({ lessonId: 'python-values-1' }, 'Quick one?')).toEqual([{ from: 'codemm', text: 'Think about it.' }]);
    expect(t.jobs.ran.filter((j) => j.kind === 'tutor').at(-1)!.resume).toBe(`session-${python}`);
    held.open();
    await waiting;
  });

  it('reports job progress for the course on screen; another course reports again once it is on screen', async () => {
    const held = gate();
    const t = live({ setup: async (job, usual) => (job.brief.includes('`react@1`') && (await held.opened), usual()) });
    const react = await approved(t, 'React');
    const setup = (await settle(() => t.api.jobProgress(), (ps) => ps.some((p) => p.kind === 'setup'), "React's setup progress")).find((p) => p.kind === 'setup')!.job;
    const heard: JobProgress[] = [];
    t.api.onJobProgress((p) => heard.push(p));
    await approved(t, 'Python');
    expect((await t.api.jobProgress()).map((p) => p.job)).not.toContain(setup);
    await t.api.switchCourse(react);
    expect((await t.api.jobProgress()).map((p) => p.job)).toContain(setup);
    await t.api.switchCourse(t.c.roadmap!.course);
    held.open();
    await settle(async () => t.c.proposals.map((p) => p.track), (ts) => ts.includes('react@1'), "React's proposal");
    await pause();
    expect(heard.filter((p) => p.job === setup)).toEqual([]);
    // Research for the second course, and its own jobs, were heard.
    expect(heard.some((p) => p.kind === 'research')).toBe(true);
  });

  it('ends a Docker stall once Check this computer passes, and starts the course again; other stalls stay', async () => {
    let problem: 'docker' | 'plan-limit' | undefined = 'docker';
    const t = live({ setup: (_job, usual) => (problem ? { ok: false, problem } : usual()) });
    await approved(t, 'React');
    await until(t.api, (c) => c.stalled === 'docker');
    problem = undefined;
    await t.api.computer();
    expect(await until(t.api, (c) => c.setup === 'consent')).not.toHaveProperty('stalled');

    const other = live({ setup: () => ({ ok: false, problem: 'plan-limit' }) });
    await approved(other, 'React');
    await until(other.api, (c) => c.stalled === 'plan-limit');
    await other.api.computer();
    await pause();
    expect((await other.api.course())!.stalled).toBe('plan-limit');
  });

  it("ends a course's Docker or disk stall once its check succeeds, and starts its work again", async () => {
    let full = false;
    const t = live({ lesson: (_job, usual) => (full ? { ok: false, problem: 'disk' } : usual()) });
    const activity = await practising(t);
    const file = activity.files[0];
    await t.api.saveFile(activity.id, file.path, 'count + 1', file.digest);
    full = true;
    // Mastering the topic makes the next topic's lesson due; it fails on a full disk.
    await t.api.check(activity.id, 'run-1');
    await until(t.api, (c) => c.stalled === 'disk');
    full = false;
    expect((await t.api.check(activity.id, 'run-2')).kind).toBe('graded');
    const course = await until(t.api, (c) => c.topics[1].lessons.some((l) => l.state === 'ready'));
    expect(course).not.toHaveProperty('stalled');
  });
});
