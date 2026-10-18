// Test fakes for the live CodemmApi: an in-memory core with the shapes and
// rules the desktop relies on, and agent jobs that act like their agents.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodemmApi, CourseView } from '../../shared/api';
import type { Job, JobOutcome } from '../agent/jobs';
import { connector } from '../connect';
import { JOB_BRIEFS } from '../../../../src/templates';
import type { CoreApp, CoreCheckView, CoreNextStep } from '../core/types';
import { createLive, type LiveDeps } from '../live';
import { createLog } from '../log';
import { desktopState } from '../state';

export const CANARY = 'printf("CANARY-SOLUTION-LINE %d", count + 1);';

/** An in-memory core with the shapes and rules the desktop relies on. */
export function fakeCore() {
  const c = {
    roadmap: null as null | { course: string; goal: string; track: string; style: string; concepts: { id: string; title: string; requires: string[] }[]; sources?: { title: string; url: string }[] },
    tracks: [] as string[],
    proposals: [] as { track: string; digest: string; created: string; files: Record<string, string> }[],
    lessons: [] as { id: string; concept: string; title: string; markdown: string; notes: string; examples?: Record<string, string>[] }[],
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
  const next = (): CoreNextStep => {
    const r = c.roadmap!;
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
    progress: (_ws, bound) => (c.bound.push(bound), {
      course: c.roadmap!.course,
      goal: c.roadmap!.goal,
      track: c.roadmap!.track,
      concepts: c.roadmap!.concepts.map((x) => ({ ...x, mastery: c.mastered.has(x.id) ? 1 : 0.5, mastered: c.mastered.has(x.id), attempts: 0, stuck: c.stuck === x.id })),
      next: next(),
    }),
    getExercise: async (_ws, slug) => {
      c.current = slug;
      return { course: c.roadmap!.course, exercise: slug!, path: '/Users/me/Codemm/exercises/x', style: 'io', concepts: [c.exercises.get(slug!)!.concept], difficulty: 1, files: ['main.c'], statement: '# Count up\n\nPrint one.', visibleTests: [{ name: 'prints one', input: '', expected: '1' }], run: './main' };
    },
    testExercise: async (_ws, slug, _bound, onProgress) => {
      if (c.down) throw new Error("The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.");
      onProgress?.({ phase: 'visible', done: 1, total: 1 });
      return view(slug!, 1, false);
    },
    checkExercise: async (_ws, slug, _bound, onProgress) => {
      if (c.down) throw new Error("The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.");
      onProgress?.({ phase: 'visible', done: 1, total: 1 });
      onProgress?.({ phase: 'hidden', done: 1, total: 2 });
      c.checks.push(slug!);
      const done = c.exercises.get(slug!)!.file.includes('count + 1');
      if (done) c.mastered.add(c.exercises.get(slug!)!.concept);
      return view(slug!, done ? 2 : 1, true);
    },
    skip: async () => undefined,
    assertRuntime: async () => undefined,
    getRoadmap: () => {
      if (!c.roadmap) throw new Error('No course in this workspace yet.');
      return c.roadmap;
    },
    listProposals: () => c.proposals,
    installProposal: (ref, digest) => c.install(ref, digest),
    dropProposal: async () => void (c.proposals = []),
    getLesson: (_ws, id) => ({ examples: [], ...c.lessons.find((l) => l.id === id)! }),
    // Run: asks for a name and greets it; stops when killed.
    runInteractive: async (_ws, slug, _bound, output, options) => {
      if (c.down) throw new Error("The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.");
      c.runs.push(slug!);
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
    },
    runExample: async (_ws, id, index) => {
      if (c.down) throw new Error("The container runtime isn't running. Start Docker Desktop and wait until it says it's running, then retry.");
      const files = c.lessons.find((l) => l.id === id)?.examples?.[index - 1];
      if (!files) throw new Error(`Lesson "${id}" has no example ${index}.`);
      return { exit: 0, output: `ran ${Object.keys(files).join(',')}\n`, errors: '' };
    },
    listExercises: (_ws, bound) => (c.bound.push(bound), [...c.exercises.entries()].map(([exercise, e]) => ({ exercise, concepts: [e.concept], difficulty: e.difficulty ?? 1, created: e.created }))),
    listLessons: (_ws, bound) => {
      c.bound.push(bound);
      return c.lessons.map((l) => ({ id: l.id, concept: l.concept, title: l.title, read: c.reads.has(l.id) }));
    },
    saveNotes: async (_ws, id, text) => void (c.lessons.find((l) => l.id === id)!.notes = text),
    markLessonRead: async (_ws, id) => void c.reads.add(id),
    readLearnerFiles: (_ws, slug) => ({ 'main.c': { text: c.exercises.get(slug)!.file, digest: c.exercises.get(slug)!.digest } }),
    writeLearnerFile: async (_ws, slug, _path, text, digest) => {
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
    roadmap: () => {
      c.roadmap!.concepts.push({ id: 'testing', title: 'Testing', requires: [] });
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
  const dir = mkdtempSync(join(tmpdir(), 'codemm-live-'));
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

export async function until(api: CodemmApi, done: (c: CourseView) => boolean) {
  for (let i = 0; i < 40; i++) {
    const c = await api.course();
    if (c && done(c)) return c;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('never settled');
}

export async function researched(t: ReturnType<typeof live>) {
  await t.api.connect('claude');
  let r = await t.api.research({ topic: 'React', known: '', depth: 'standard' });
  for (let i = 0; i < 20 && r.state === 'running'; i++) {
    await new Promise((res) => setTimeout(res, 5));
    r = await t.api.research({ topic: 'React', known: '', depth: 'standard' });
  }
  return r;
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

