// The CodemmApi over the real core and the learner's own agent (DESIGN §2–§6).
// Main calls core `app` functions in-process; agent jobs run through the
// bridge; everything returned goes through views.ts.
import {
  AGENT_FAILED,
  CHANGED,
  PLAN_LIMIT,
  REPAIR,
  SIGNED_OUT,
  type CodemmApi,
  type Computer,
  type Concept,
  type CourseView,
  type Proposal,
  type Roadmap,
  type SetupProblem,
} from '../shared/api';
import models from '../shared/models.json';
import type { McpServer } from './agent/agents';
import { briefsFrom, courseId } from './agent/briefs';
import { runJob as realRunJob, type Job, type JobKind, type JobOutcome, type JobProblem } from './agent/jobs';
import type { connector } from './connect';
import { infra } from './core/failures';
import { errorFields, SafeError } from './errors';
import type { CoreApp, CoreProgress, CoreRoadmap } from './core/types';
import { courseView, currentConcept, type Setup } from './courseView';
import { noLog, type Log } from './log';
import type { desktopState } from './state';
import { activityView, checkView, filterReply, hiddenLines, tryView } from './views';

export interface LiveDeps {
  core: CoreApp;
  connect: ReturnType<typeof connector>;
  computer: () => Promise<Computer>;
  state: ReturnType<typeof desktopState>;
  /** The learner's workspace, ~/Codemm by default (O5). */
  ws: string;
  /** The MCP server one job's agent starts, bound to its course and tools (§2, §4.6). */
  server: (course: string | undefined, tools: string[]) => McpServer;
  /** The app's own executable, which runs Node-script agents. */
  runtime?: string;
  runJob?: (job: Job) => Promise<JobOutcome>;
  /** Lifecycle and detection events only (log.ts). */
  log?: Log;
  /** Resolves once Docker isn't starting any more (§6.1). */
  dockerReady?: () => Promise<void>;
}

export interface Live extends CodemmApi {
  /** Stops every agent job with its process group, then removes leftover containers (§5). */
  stop(): Promise<void>;
}

/** Setup proposals per setup before the learner gets Stop or Try again (§3.2). */
const PROPOSAL_BOUND = 3;
const problemError = (problem: JobProblem) => new Error({ 'plan-limit': PLAN_LIMIT, 'signed-out': SIGNED_OUT, failed: AGENT_FAILED }[problem]);
const NOT_COUNTED: Record<'docker' | 'disk' | 'offline', string> = {
  docker: "Docker isn't running.",
  disk: 'Docker ran out of disk space.',
  offline: "Docker couldn't reach the network.",
};

/** An infrastructure failure during Try it or Check isn't counted (§5). */
function notCounted(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/image for .* is missing or changed/i.test(message)) return 'This environment needs a rebuild. Rebuild it under Tracks.';
  const kind = infra(message);
  return kind ? NOT_COUNTED[kind] : null;
}

/** core store.ts's damaged-record errors: the learner repairs them; a retry can't (§5). */
const DAMAGED = /^Codemm's record .* is damaged|^The learning log .* has an invalid entry/;
function repairable(e: unknown): unknown {
  if (e instanceof Error && e.name === 'CodemmError' && DAMAGED.test(e.message)) e.message = `${REPAIR}\n${e.message}`;
  return e;
}

interface Running {
  outcome: Promise<JobOutcome>;
  stop: AbortController;
}

export function createLive(d: LiveDeps): Live {
  const { core, ws } = d;
  const runJob = d.runJob ?? realRunJob;
  const log = d.log ?? noLog;
  const dockerReady = d.dockerReady ?? (async () => {});
  const briefs = briefsFrom(core.JOB_BRIEFS);
  const running = new Map<string, Running>();
  const lanes = { fg: Promise.resolve() as Promise<unknown>, bg: Promise.resolve() as Promise<unknown> };
  const outcomes = new Map<string, JobOutcome>();
  let stalled: CourseView['stalled'];
  let tutorTurns: Promise<unknown> = Promise.resolve();
  let tutorTurnCount = 0;
  /** Set once quitting starts: nothing new runs (§5). */
  let stopping = false;
  /** Checks and Try its in flight: their containers belong to this process until they end. */
  const runs = new Set<Promise<unknown>>();
  const tracked = <T>(run: Promise<T>): Promise<T> => {
    runs.add(run);
    return run.finally(() => runs.delete(run));
  };
  // Containers left by an earlier run of the app, whose owner is gone (§5).
  void core.cleanupLeftovers().catch(() => undefined);
  /** The setup the learner approved, and how it went (§4.1). */
  let setup: { installing?: Promise<void>; approved?: Proposal; problem?: SetupProblem; gateFailures: number; lastGateProblem?: string; installs: number } = { gateFailures: 0, installs: 0 };

  const roadmapOrNull = (): CoreRoadmap | null => {
    try {
      return core.getRoadmap(ws);
    } catch {
      return null;
    }
  };
  const installed = (ref: string) => core.listTracks().some((t) => t.track === ref);
  const trackName = (ref: string) => ref.split('@')[0];
  const roadmapView = (r: CoreRoadmap): Roadmap => ({ goal: r.goal, track: trackName(r.track), installed: installed(r.track), concepts: r.concepts.map((c) => ({ id: c.id, title: c.title, requires: [...c.requires] })) });
  const hidden = (): string[] => {
    const { course, current } = core.readWorkspace(ws);
    if (!course || !current) return [];
    try {
      const { record, files } = core.readExercise(course, current);
      return hiddenLines(files, record.expected);
    } catch {
      return [];
    }
  };

  /** Saves the learner's edits through core's roadmap rules (§4.2). JSON is YAML. */
  async function saveConcepts(concepts: Concept[]) {
    const current = core.getRoadmap(ws);
    await core.saveRoadmap(ws, current.course, JSON.stringify({ goal: current.goal, track: current.track, style: current.style, concepts }), current.course);
  }

  /**
   * Runs one agent job in a lane: one foreground job and one background queue,
   * each one at a time (§3.2). The job starts only when its turn comes.
   */
  function start(key: string, lane: 'fg' | 'bg', kind: JobKind, brief: string, course: string | undefined, done: Job['done'], resume?: string): Promise<JobOutcome> {
    const existing = running.get(key);
    if (existing) return existing.outcome;
    if (stopping) return Promise.resolve({ ok: false, problem: 'failed', text: [] });
    const stop = new AbortController();
    const job = async (): Promise<JobOutcome> => {
      // A cancelled job, or background work queued behind a stall, never launches.
      if (stop.signal.aborted || (lane === 'bg' && stalled)) return { ok: false, problem: 'failed', text: [] };
      const { id, exe } = await d.connect.chosen();
      const began = Date.now();
      log('job-start', { kind, lane, agent: id });
      const outcome = await runJob({
        kind,
        agent: id,
        exe,
        runtime: d.runtime,
        brief,
        server: (tools) => d.server(course, tools),
        cwd: ws,
        // Codex jobs ignore the learner's config, so they run the recommended model (§3.3).
        model: id === 'codex' ? (models.codex ?? undefined) : undefined,
        resume,
        signal: stop.signal,
        done,
        signedIn: () => d.connect.recheck(id, exe),
      });
      log('job-end', { kind, ok: outcome.ok, problem: outcome.problem, cancelled: stop.signal.aborted || undefined, ms: Date.now() - began });
      return outcome;
    };
    const outcome = lanes[lane].then(job, job).finally(() => running.delete(key));
    lanes[lane] = outcome.catch(() => undefined);
    running.set(key, { outcome, stop });
    return outcome;
  }

  /** Stops the jobs whose keys match, and waits until their agents are gone. */
  async function cancel(match: (key: string) => boolean) {
    const stopping = [...running.entries()].filter(([key]) => match(key));
    for (const [, r] of stopping) r.stop.abort();
    await Promise.all(stopping.map(([, r]) => r.outcome.catch(() => undefined)));
  }

  /** Background work: a failure stalls it until the learner retries, instead of relaunching on every look. */
  function background(key: string, kind: JobKind, brief: string, course: string, done: Job['done'], lane: 'fg' | 'bg' = 'bg') {
    if (stopping || stalled || running.has(key)) return;
    const outcome = start(key, lane, kind, brief, course, done);
    const controller = running.get(key)?.stop;
    // The first stall is the one the learner sees.
    outcome
      .then((o) => {
        if (!o.ok && !controller?.signal.aborted) stalled ??= o.problem ?? 'failed';
        // A finished job can make the next one due: the lesson before the activity, a proposal after gates.
        else if (o.ok) schedule();
      })
      .catch((e: Error) => {
        log('job-error', { job: kind, ...errorFields(e) });
        stalled ??= e.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed';
      });
  }

  function latestProposal(ref: string): Proposal | undefined {
    const latest = core.listProposals().filter((p) => p.track === ref).sort((a, b) => b.created.localeCompare(a.created))[0];
    return latest && { digest: latest.digest, retry: setup.gateFailures > 0, files: Object.entries(latest.files).map(([path, text]) => ({ path, text })) };
  }

  /** One consent before setup (§4.1): propose, wait for the learner, build exactly what they saw. */
  function setupState(progress: CoreProgress): Setup {
    const ref = progress.track;
    if (installed(ref)) return { state: 'ready' };
    if (setup.installing) return { state: 'installing' };
    // A fixable failure keeps the approved proposal, so Try again builds the same files without asking again.
    if (setup.problem) return { state: 'failed', problem: setup.problem, ...(setup.approved ? { proposal: setup.approved } : {}) };
    if (setup.gateFailures >= PROPOSAL_BOUND) return { state: 'failed', problem: 'gates' };
    const proposal = latestProposal(ref);
    if (proposal) return { state: 'consent', proposal };
    return { state: 'proposing' };
  }

  /**
   * Starts the background work the course needs: a setup proposal, the current topic's lesson and
   * activity. Only Codemm's own steps call it, never a read, so reopening a lesson or an activity
   * starts no agent (D9).
   */
  function schedule() {
    try {
      const roadmap = roadmapOrNull();
      if (!roadmap || d.state.read().approved !== roadmap.course) return;
      const progress = core.progress(ws, roadmap.course);
      const state = progress.next.kind === 'setup' ? setupState(progress) : ({ state: 'ready' } as const);
      if (state.state === 'proposing') {
        const ref = progress.track;
        const before = new Set(core.listProposals().map((p) => p.digest));
        // Done once it proposed: the proposal may already be gone if the learner approved it and its gates failed.
        const installs = setup.installs;
        const proposed = () => setup.installs > installs || core.listProposals().some((p) => p.track === ref && !before.has(p.digest));
        background(`setup:${progress.course}`, 'setup', briefs.setup(ref, setup.lastGateProblem), progress.course, proposed);
      }
      work(progress, state.state === 'ready');
    } catch (e) {
      log('schedule-error', { name: e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : 'thrown' });
    }
  }

  /** The lesson (from the start, beside setup) and the activity (once set up) the current topic needs (§3.2, §4.3). */
  function work(progress: CoreProgress, ready: boolean) {
    const course = progress.course;
    const concept = progress.concepts.find((c) => c.id === currentConcept(progress));
    if (!concept) return;
    const lessons = () => core.listLessons(ws, course).filter((l) => l.concept === concept.id).length;
    if (lessons() === 0) {
      // The course's first lesson runs in the foreground, beside setup (§3.2).
      const lane = core.listLessons(ws, course).length === 0 ? 'fg' : 'bg';
      background(`lesson:${course}:${concept.id}`, 'lesson', briefs.lesson(concept.id, concept.title), course, () => lessons() > 0, lane);
    }
    if (ready && progress.next.kind === 'author') {
      // Done only by a new exercise for this concept at the requested difficulty (§3.2).
      // The agent reads its target and the track's contract from next_step (core JOB_BRIEFS.author).
      const { difficulty } = progress.next;
      const before = new Set(core.listExercises(ws, course).map((e) => e.exercise));
      const made = () => core.listExercises(ws, course).some((e) => !before.has(e.exercise) && e.concepts.includes(concept.id) && e.difficulty === difficulty);
      background(`author:${course}:${concept.id}:${difficulty}`, 'author', briefs.author(), course, made);
    }
  }

  async function foreground(key: string, kind: JobKind, brief: string, course: string | undefined, done: Job['done'], resume?: string) {
    const outcome = await start(key, 'fg', kind, brief, course, done, resume);
    if (!outcome.ok && outcome.problem) throw problemError(outcome.problem);
    return outcome;
  }

  /** A roadmap change may move the course to another track: the old track's setup and author jobs stop, and its proposals go (§4.2). */
  async function roadmapJob(brief: string, done: (before: string) => Job['done']) {
    const before = core.getRoadmap(ws);
    const saved = JSON.stringify(before);
    await cancel((key) => key.startsWith('setup:') || key.startsWith('author:'));
    const outcome = await foreground(`roadmap:${before.course}`, 'roadmap', brief, before.course, done(saved));
    const after = core.getRoadmap(ws);
    if (after.track !== before.track) {
      await core.dropProposal(before.track);
      setup = { gateFailures: 0, installs: 0 };
    }
    return { outcome, changed: JSON.stringify(after) !== saved, after };
  }

  /** The saved activity for a concept, even when the next step recommends something else (stuck, §3.2). */
  function exerciseFor(concept: string, course: string): string | undefined {
    const next = core.progress(ws, course).next;
    if (next.kind === 'practice' && next.concept === concept) return next.exercise;
    return core.listExercises(ws, course).filter((e) => e.concepts.includes(concept)).sort((a, b) => b.created.localeCompare(a.created))[0]?.exercise;
  }

  // Work the course still needs when the app starts.
  queueMicrotask(schedule);

  const api: Live = {
    async agents() {
      const agents = await d.connect.agents();
      log('agents', Object.fromEntries(agents.map((a) => [a.id, a.untested ? `${a.state}-untested` : a.state])));
      return agents;
    },
    async connect(id) {
      const agent = await d.connect.connect(id);
      log('connect', { agent: id, state: agent.state, untested: agent.untested || undefined });
      // Signing in again ends a sign-out that stopped background work.
      if (agent.state === 'connected' && stalled === 'signed-out') {
        stalled = undefined;
        schedule();
      }
      return agent;
    },
    async computer() {
      const computer = await d.computer();
      log('computer', { platform: computer.platform, ...Object.fromEntries(computer.checks.map((c) => [c.id, c.detail ?? c.state])) });
      return computer;
    },

    async tracks() {
      return core.listTracks().map((t) => ({ ref: t.track, name: trackName(t.track) }));
    },

    async research(goal) {
      const key = `research:${goal.topic}`;
      const outcome = outcomes.get(key);
      if (outcome) {
        outcomes.delete(key);
        if (!outcome.ok) {
          if (outcome.problem && outcome.problem !== 'failed') throw problemError(outcome.problem);
          return { state: 'failed' };
        }
        return { state: 'done', roadmap: roadmapView(core.getRoadmap(ws)) };
      }
      if (!running.has(key)) {
        await d.connect.chosen();
        // A new course, on a server that saves only it (§4.6).
        const course = courseId(goal.topic, Date.now());
        start(key, 'fg', 'research', briefs.research(course, goal.topic, goal.known), course, () => roadmapOrNull()?.course === course)
          .then((o) => outcomes.set(key, o))
          .catch((e: Error) => outcomes.set(key, { ok: false, problem: e.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed', text: [] }));
      }
      return { state: 'running' };
    },

    async reviseRoadmap(concepts, request) {
      await saveConcepts(concepts);
      const { outcome, changed, after } = await roadmapJob(briefs.roadmap(request), (before) => (turn) => turn.ok || JSON.stringify(core.getRoadmap(ws)) !== before);
      schedule();
      const filter = hidden();
      return { roadmap: roadmapView(after), changed, text: outcome.text.map((t) => filterReply(t, filter)).join('\n\n') };
    },

    async approve(concepts) {
      await saveConcepts(concepts);
      const course = core.getRoadmap(ws).course;
      d.state.update((s) => ({ ...s, approved: course }));
      stalled = undefined;
      setup = { gateFailures: 0, installs: 0 };
      schedule();
    },

    /** A read: it starts nothing (D9). */
    async course() {
      const roadmap = roadmapOrNull();
      if (!roadmap || d.state.read().approved !== roadmap.course) return null;
      const progress = core.progress(ws, roadmap.course);
      const state = progress.next.kind === 'setup' ? setupState(progress) : ({ state: 'ready' } as const);
      const jobs = new Set([...running.keys()].map((k) => k.replace(`:${roadmap.course}`, '')));
      const view = courseView(progress, core.listLessons(ws, roadmap.course), state, jobs);
      return stalled ? { ...view, stalled } : view;
    },

    async install(digest) {
      const ref = core.progress(ws).track;
      const proposal = setup.approved?.digest === digest ? setup.approved : latestProposal(ref);
      if (!proposal || proposal.digest !== digest) throw new SafeError('The setup changed. Look at it again.');
      setup.approved = proposal;
      setup.problem = undefined;
      setup.installs++;
      setup.installing = dockerReady()
        .then(() => core.installProposal(ref, digest))
        .then(() => {
          setup.approved = undefined;
        })
        .catch((e: Error) => {
          // This computer's problems keep the proposal for Try again; nothing is recorded and no agent runs (§6.1).
          const kind = infra(e.message);
          log('setup-failed', { problem: kind ?? 'gates' });
          if (kind) {
            setup.problem = kind;
            return;
          }
          setup.approved = undefined;
          setup.gateFailures++;
          setup.lastGateProblem = e.message;
          void core.dropProposal(ref).catch(() => undefined);
        })
        .finally(() => {
          setup.installing = undefined;
          schedule();
        });
    },

    async retrySetup() {
      setup = { gateFailures: 0, installs: 0 };
      stalled = undefined;
      schedule();
    },

    async retryJobs() {
      stalled = undefined;
      schedule();
    },

    async lesson(id) {
      return core.getLesson(ws, id);
    },
    saveNotes: (id, notes) => core.saveNotes(ws, id, notes),
    async markRead(id) {
      await core.markLessonRead(ws, id);
      schedule();
    },

    async activity(concept) {
      const course = core.getRoadmap(ws).course;
      const slug = exerciseFor(concept, course);
      if (!slug) throw new SafeError('This activity isn’t ready yet.');
      const exercise = await core.getExercise(ws, slug, course);
      return activityView(exercise, core.readLearnerFiles(ws, slug, course), concept);
    },

    async saveFile(activityId, path, text, digest) {
      try {
        return (await core.writeLearnerFile(ws, activityId, path, text, digest)).digest;
      } catch (e) {
        if (/changed outside codemm/i.test((e as Error).message)) throw new Error(CHANGED);
        throw e;
      }
    },

    async tryIt(activityId) {
      try {
        await dockerReady();
        return tryView(await tracked(core.testExercise(ws, activityId)));
      } catch (e) {
        const reason = notCounted(e);
        if (reason) {
          log('not-counted', { run: 'try', reason });
          return { kind: 'not-counted', reason };
        }
        throw e;
      }
    },

    async check(activityId) {
      try {
        await dockerReady();
        const view = await tracked(core.checkExercise(ws, activityId));
        const concepts = core.listExercises(ws).find((e) => e.exercise === activityId)?.concepts ?? [];
        const state = core.progress(ws).concepts.find((c) => concepts.includes(c.id));
        // A graded check can move the course on: the next topic's lesson and activity.
        schedule();
        return checkView(view, { stuck: state?.stuck ?? false, mastered: state?.mastered ?? false });
      } catch (e) {
        const reason = notCounted(e);
        if (reason) {
          log('not-counted', { run: 'check', reason });
          return { kind: 'not-counted', reason };
        }
        throw e;
      }
    },

    async ask(place, text) {
      const { id } = await d.connect.chosen();
      const course = core.getRoadmap(ws).course;
      const key = `${course}|${id}`;
      const where = 'lessonId' in place ? `the lesson "${place.lessonId}" (get_lesson)` : `the activity "${place.activityId}" (get_exercise)`;
      // The learner's own code goes to their own agent; nothing hidden does.
      const files = 'activityId' in place ? Object.fromEntries(Object.entries(core.readLearnerFiles(ws, place.activityId, course)).map(([path, f]) => [path, f.text])) : undefined;
      // Each question is its own turn, after the one before, so it resumes the session that turn left (§3.2).
      const turn = tutorTurns.then(async () => {
        const outcome = await foreground(`tutor:${key}:${++tutorTurnCount}`, 'tutor', briefs.tutor(where, text, files), course, (t) => t.ok, d.state.read().sessions[key]);
        if (outcome.session) d.state.update((s) => ({ ...s, sessions: { ...s.sessions, [key]: outcome.session! } }));
        return outcome;
      });
      tutorTurns = turn.catch(() => undefined);
      const outcome = await turn;
      const filter = hidden();
      return outcome.text.map((t) => ({ from: 'codemm' as const, text: filterReply(t, filter) }));
    },

    async skip(concept) {
      await core.skip(ws, concept);
      schedule();
    },

    async easier(concept) {
      const title = core.getRoadmap(ws).concepts.find((c) => c.id === concept)?.title ?? concept;
      await roadmapJob(briefs.easier(concept, title), (before) => () => JSON.stringify(core.getRoadmap(ws)) !== before);
      schedule();
    },

    async rebuild(ref) {
      await core.rebuildTrack(ref);
    },

    async stop() {
      stopping = true;
      log('quit', { jobs: running.size, runs: runs.size });
      await cancel(() => true);
      await Promise.all([...runs].map((r) => r.catch(() => undefined)));
      await core.cleanupLeftovers().catch(() => undefined);
    },
  };
  // Every call: a damaged record says so, with core's guidance.
  for (const name of Object.keys(api) as (keyof Live)[]) {
    const call = api[name] as (...args: unknown[]) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => call.apply(api, args).catch((e: unknown) => Promise.reject(repairable(e)));
  }
  return api;
}
