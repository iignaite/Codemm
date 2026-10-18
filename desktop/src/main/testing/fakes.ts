// Test fakes for the live CodemmApi: an in-memory core with the shapes and
// rules the desktop relies on, and agent jobs that act like their agents.
import { join } from 'node:path';
import type { CodemmApi, CourseView } from '../../shared/api';
import type { Job, JobOutcome } from '../agent/jobs';
import { connector } from '../connect';
import { JOB_BRIEFS } from '../../../../src/templates';
import type { CoreApp, CoreCheckView, CoreNextStep, CoreProgramRun } from '../core/types';
import { createLive, type LiveDeps } from '../live';
import { createLog } from '../log';
import { desktopState } from '../state';
import { tempDir } from './temp';

export const CANARY = 'printf("CANARY-SOLUTION-LINE %d", count + 1);';

type FakeRoadmap = { course: string; goal: string; track: string; style: string; concepts: { id: string; title: string; requires: string[] }[]; sources?: { title: string; url: string }[] };

const DOCKER_DOWN = "The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.";

/** A program that asks for a name and greets it; stops when killed. */
function greeter(output: (text: string, stream: 'stdout' | 'stderr') => void, options?: { onStart?: (stage: 'build' | 'run', limitMs: number) => void }): CoreProgramRun {
  let end!: (r: { exit: number; stage?: 'run'; timedOut: boolean; flooded: boolean; stopped?: boolean }) => void;
  const done = new Promise<{ exit: number; stage?: 'run'; timedOut: boolean; flooded: boolean; stopped?: boolean }>((resolve) => (end = resolve));
  options?.onStart?.('run', 120_000);
  output('name? ', 'stdout');
  return {
    write: (text) => {
      output(`hello ${text.trim()}\n`, 'stdout');
      output('a warning\n', 'stderr');
      end({ exit: 0, stage: 'run', timedOut: false, flooded: false });
      return true;
    },
    kill: () => end({ exit: 137, timedOut: false, flooded: false, stopped: true }),
    done,
  };
}

/** An in-memory core with the shapes and rules the desktop relies on. */
export function fakeCore() {
  const c = {
    /** Every saved course, and the workspace's active one, as core keeps them. */
    courses: new Map<string, FakeRoadmap>(),
    active: undefined as string | undefined,
    /** The active course's roadmap. Saving one makes it active, as core's saveRoadmap does. */
    get roadmap(): FakeRoadmap | null {
      return (this.active && this.courses.get(this.active)) || null;
    },
    set roadmap(r: FakeRoadmap | null) {
      if (r) this.courses.set(r.course, r);
      this.active = r?.course;
    },
    tracks: [] as string[],
    proposals: [] as { track: string; digest: string; created: string; files: Record<string, string> }[],
    lessons: [] as { id: string; concept: string; title: string; markdown: string; notes: string; examples?: Record<string, string>[]; style?: 'io' | 'unit' }[],
    reads: new Set<string>(),
    exercises: new Map<string, { concept: string; file: string; digest: string; created: string; difficulty?: number }>(),
    /** The difficulty next_step asks the author for, and the one the fake author writes. */
    wanted: 1,
    writes: 1,
    /** The course argument each bound core call got. */
    bound: [] as (string | undefined)[],
    cleanups: 0,
    mastered: new Set<string>(),
    /** The concept core says the learner is stuck on. */
    stuck: undefined as string | undefined,
    current: undefined as string | undefined,
    /** A mastered concept due for review, on this exercise (core §7). */
    review: undefined as undefined | { concept: string; exercise: string },
    /** A mastered concept due for review with no unused exercise: core asks for one (author, review: true). */
    reviewWithout: undefined as string | undefined,
    install: async (_ref: string, _digest: string): Promise<unknown> => {
      c.tracks.push('react@1');
      return {};
    },
    checks: [] as string[],
    /** Exercises Run started. */
    runs: [] as string[],
    down: false,
  };
  /** A bound call's course, else the active one (core's activeCourse). */
  const roadmapOf = (bound?: string) => {
    const r = bound ? c.courses.get(bound) : c.roadmap;
    if (!r) throw new Error(bound ? `Course "${bound}" is missing from /home.` : 'No course in this workspace yet.');
    return r;
  };
  const next = (bound?: string): CoreNextStep => {
    const r = roadmapOf(bound);
    if (!c.tracks.includes(r.track)) return { kind: 'setup', track: r.track };
    if (c.review) return { kind: 'review', concept: c.review.concept, difficulty: c.wanted, exercise: c.review.exercise };
    if (c.reviewWithout) return { kind: 'author', concept: c.reviewWithout, difficulty: c.wanted, review: true };
    const concept = r.concepts.find((x) => !c.mastered.has(x.id) && x.requires.every((q) => c.mastered.has(q)));
    if (!concept) return { kind: 'done' };
    if (c.stuck === concept.id) return { kind: 'stuck', concept: concept.id };
    const own = c.lessons.filter((l) => l.concept === concept.id);
    const lesson = own.length === 0 ? null : own.find((l) => !c.reads.has(l.id))?.id;
    const ex = [...c.exercises.entries()].find(([, e]) => e.concept === concept.id);
    const lessonField = lesson === undefined ? {} : { lesson };
    return ex ? { kind: 'practice', exercise: ex[0], concept: concept.id, ...lessonField } : { kind: 'author', concept: concept.id, difficulty: c.wanted, ...lessonField };
  };
  const view = (slug: string, passed: number, recorded: boolean): CoreCheckView => ({
    exercise: slug,
    passed,
    total: 2,
    recorded,
    tests: [{ name: 'prints one', status: passed === 2 ? 'pass' : 'fail', ...(passed === 2 ? {} : { actual: '0' }) }, { name: 'hidden #1', status: 'pass' }],
  });
  const app: CoreApp = {
    JOB_BRIEFS,
    doctor: async () => [],
    readWorkspace: () => ({ course: c.roadmap?.course, current: c.current }),
    readExercise: () => ({
      record: { expected: { 'hidden/1': 'CANARY-EXPECTED-OUTPUT-LINE 42' } },
      files: {
        'solution/main.c': CANARY,
        'mutants/off-by-one/main.c': 'printf("CANARY-MUTANT-LINE %d", count + 2);',
        'tests/hidden/1.in': 'CANARY-HIDDEN-INPUT-LINE with enough length',
        'README.md': '# Count',
      },
    }),
    listTracks: () => c.tracks.map((track) => ({ track, styles: ['io'], files: ['main.c'] })),
    cleanupLeftovers: async () => void c.cleanups++,
    rebuildTrack: async () => ({}),
    saveRoadmap: async (_ws, course, yaml) => {
      const parsed = JSON.parse(yaml);
      c.roadmap = { course, ...parsed };
      return { course };
    },
    progress: (_ws, bound) => {
      c.bound.push(bound);
      const r = roadmapOf(bound);
      return {
        course: r.course,
        goal: r.goal,
        track: r.track,
        concepts: r.concepts.map((x) => ({ ...x, mastery: c.mastered.has(x.id) ? 1 : 0.5, mastered: c.mastered.has(x.id), attempts: 0, stuck: c.stuck === x.id })),
        next: next(bound),
      };
    },
    getExercise: async (_ws, slug, bound) => {
      c.bound.push(bound);
      c.current = slug;
      return { course: roadmapOf(bound).course, exercise: slug!, path: '/Users/me/Codemm/exercises/x', style: 'io', concepts: [c.exercises.get(slug!)!.concept], difficulty: 1, files: ['main.c'], statement: '# Count up\n\nPrint one.', visibleTests: [{ name: 'prints one', input: '', expected: '1' }], run: './main' };
    },
    testExercise: async (_ws, slug, bound, onProgress) => {
      c.bound.push(bound);
      if (c.down) throw new Error(DOCKER_DOWN);
      onProgress?.({ phase: 'visible', done: 1, total: 1 });
      onProgress?.({ phase: 'visible', done: 1, total: 1, test: { name: 'visible/01', status: 'fail', message: 'Output differs from the expected output.', actual: '0\n' } });
      return view(slug!, 1, false);
    },
    checkExercise: async (_ws, slug, bound, onProgress) => {
      c.bound.push(bound);
      if (c.down) throw new Error(DOCKER_DOWN);
      onProgress?.({ phase: 'visible', done: 1, total: 1 });
      // A hidden event never carries a test, even if core sent one.
      onProgress?.({ phase: 'hidden', done: 1, total: 2, test: { name: 'hidden/01', status: 'fail', actual: 'CANARY-HIDDEN-OUTPUT' } });
      c.checks.push(slug!);
      const done = c.exercises.get(slug!)!.file.includes('count + 1');
      if (done) c.mastered.add(c.exercises.get(slug!)!.concept);
      return view(slug!, done ? 2 : 1, true);
    },
    skip: async (_ws, _concept, bound) => void c.bound.push(bound),
    assertRuntime: async () => undefined,
    getRoadmap: (_ws, bound) => roadmapOf(bound),
    listProposals: () => c.proposals,
    installProposal: (ref, digest) => c.install(ref, digest),
    dropProposal: async () => void (c.proposals = []),
    getLesson: (_ws, id, bound) => (c.bound.push(bound), { examples: [], ...c.lessons.find((l) => l.id === id)! }),
    // Run: asks for a name and greets it; stops when killed.
    runInteractive: async (_ws, slug, bound, output, options) => {
      c.bound.push(bound);
      if (c.down) throw new Error(DOCKER_DOWN);
      c.runs.push(slug!);
      return greeter(output, options);
    },
    runExampleLive: async (_ws, id, index, _bound, output, options) => {
      if (c.down) throw new Error(DOCKER_DOWN);
      c.runs.push(`${id}#${index}`);
      return greeter(output, options);
    },
    runExample: async (_ws, id, index, bound) => {
      c.bound.push(bound);
      if (c.down) throw new Error(DOCKER_DOWN);
      const files = c.lessons.find((l) => l.id === id)?.examples?.[index - 1];
      if (!files) throw new Error(`Lesson "${id}" has no example ${index}.`);
      return { exit: 0, output: `ran ${Object.keys(files).join(',')}\n`, errors: '' };
    },
    listExercises: (_ws, bound) => (c.bound.push(bound), [...c.exercises.entries()].map(([exercise, e]) => ({ exercise, concepts: [e.concept], difficulty: e.difficulty ?? 1, created: e.created }))),
    listLessons: (_ws, bound) => {
      c.bound.push(bound);
      return c.lessons.map((l) => ({ id: l.id, concept: l.concept, title: l.title, read: c.reads.has(l.id) }));
    },
    saveNotes: async (_ws, id, text, bound) => void (c.bound.push(bound), (c.lessons.find((l) => l.id === id)!.notes = text)),
    markLessonRead: async (_ws, id, bound) => void (c.bound.push(bound), c.reads.add(id)),
    readLearnerFiles: (_ws, slug, bound) => (c.bound.push(bound), { 'main.c': { text: c.exercises.get(slug)!.file, digest: c.exercises.get(slug)!.digest } }),
    writeLearnerFile: async (_ws, slug, _path, text, digest, bound) => {
      c.bound.push(bound);
      const ex = c.exercises.get(slug)!;
      if (ex.digest !== digest) throw new Error('Changed outside Codemm since it was loaded.');
      ex.file = text;
      ex.digest = String(Number(digest) + 1).padStart(64, '0');
      return { digest: ex.digest };
    },
  };
  return { c, app };
}

/** Fake agent jobs: each does what its job's agent would do through Codemm's tools. */
type Act = (job: Job) => Partial<JobOutcome> | Promise<Partial<JobOutcome>>;

export function fakeJobs(c: ReturnType<typeof fakeCore>['c'], over: Partial<Record<Job['kind'], Act>> = {}) {
  const ran: Job[] = [];
  const act: Record<Job['kind'], Act> = {
    research: (job) => {
      // Saves under the course its server is bound to, as core requires.
      const args = job.server([]).args;
      c.roadmap = { course: args[args.indexOf('--course') + 1], goal: 'React', track: 'react@1', style: 'io', concepts: [{ id: 'values', title: 'Values', requires: [] }, { id: 'state', title: 'State', requires: ['values'] }] };
      return {};
    },
    roadmap: (job) => {
      // Changes the course its server is bound to.
      const args = job.server([]).args;
      c.courses.get(args[args.indexOf('--course') + 1])!.concepts.push({ id: 'testing', title: 'Testing', requires: [] });
      return { text: ['Added Testing.'] };
    },
    setup: () => {
      c.proposals.push({ track: 'react@1', digest: 'a'.repeat(64), created: new Date().toISOString(), files: { Dockerfile: 'FROM node:22', 'track.yaml': 'id: react' } });
      return {};
    },
    lesson: () => {
      const concept = (c.roadmap!.concepts.find((x) => !c.mastered.has(x.id)) ?? c.roadmap!.concepts[0]).id;
      c.lessons.push({ id: `${concept}-1`, concept, title: `About ${concept}`, markdown: '# About\n\nText.', notes: '' });
      return {};
    },
    author: () => {
      const concept = c.roadmap!.concepts.find((x) => !c.mastered.has(x.id))!.id;
      c.exercises.set(`${concept}-${c.writes === 1 ? 'easy' : `d${c.writes}`}-1`, { concept, file: 'int main() { /* yours */ }', digest: '0'.repeat(64), created: new Date().toISOString(), difficulty: c.writes });
      return {};
    },
    tutor: () => ({ text: ['Look at what you add.'], session: 'session-1' }),
    ...over,
  };
  const runJob = async (job: Job): Promise<JobOutcome> => {
    ran.push(job);
    await new Promise((r) => setTimeout(r, 1));
    const out = await act[job.kind](job);
    if (out.ok === false) return { ok: false, text: [], ...out };
    return { ok: await job.done({ ok: true }), text: [], ...out };
  };
  return { ran, runJob };
}

export function live(over: Partial<Record<Job['kind'], Act>> = {}, deps: Partial<LiveDeps> = {}) {
  const { c, app } = fakeCore();
  const jobs = fakeJobs(c, over);
  const dir = tempDir('codemm-live-');
  const state = desktopState(dir);
  const lookup = { find: (bin: string) => ({ path: `/bin/${bin}`, js: false }), signedIn: async () => true, version: async () => '2.1.283' };
  const connect = connector(lookup, state);
  const api = createLive({
    core: app,
    connect,
    computer: async () => ({ platform: 'mac', checks: [], ready: true }),
    state,
    ws: '/Users/me/Codemm',
    agentDir: '/userData/agents',
    server: (course, tools) => ({ command: '/app', args: ['core/cli.mjs', 'mcp', ...(course ? ['--course', course] : []), '--tools', tools.join(',')] }),
    runJob: jobs.runJob,
    log: createLog(dir),
    ...deps,
  });
  return { api, c, app, jobs, connect, dir, logFile: join(dir, 'codemm.log') };
}

/** Reads until `done` holds, for up to 2 s, then fails. A read that throws fails at once. */
export async function settle<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} never settled`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function until(api: CodemmApi, done: (c: CourseView) => boolean) {
  return (await settle(() => api.course(), (c) => c !== null && done(c), 'The course'))!;
}

export async function researched(t: ReturnType<typeof live>) {
  await t.api.connect('claude');
  return settle(() => t.api.research({ topic: 'React', known: '', depth: 'standard' }), (r) => r.state !== 'running', 'Research');
}

export async function practising(t: ReturnType<typeof live>) {
  const r = await researched(t);
  await t.api.approve(r.roadmap!.concepts);
  const consent = await until(t.api, (c) => c.setup === 'consent');
  await t.api.install(consent.proposal!.digest);
  const course = await until(t.api, (c) => c.setup === 'ready' && c.topics[0].lessons.some((l) => l.state === 'ready'));
  for (const l of course.topics[0].lessons) if (l.state === 'ready') await t.api.markRead(l.id);
  await until(t.api, (c) => c.topics[0].activity === 'open');
  return t.api.activity('values');
}

