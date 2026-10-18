// The CodemmApi over the real core and the learner's own agent (DESIGN §2–§6).
// Main calls core `app` functions in-process; agent jobs run through the
// bridge; everything returned goes through views.ts.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_FAILED,
  CHANGED,
  OFFLINE,
  PLAN_LIMIT,
  REPAIR,
  SIGNED_OUT,
  UNSTOPPABLE,
  type CheckProgress,
  type JobProgress,
  type CodemmApi,
  type Computer,
  type Concept,
  type CourseView,
  type Proposal,
  type Roadmap,
  type SetupProblem,
} from '../shared/api';
import type { McpServer } from './agent/agents';
import { watchGates } from './agent/gateFile';
import { jobTracker, type JobTracker } from './agent/progress';
import { briefsFrom, courseId } from './agent/briefs';
import { runJob as realRunJob, type Job, type JobKind, type JobOutcome, type JobProblem } from './agent/jobs';
import type { connector } from './connect';
import { infraOf, kindOf } from './core/failures';
import { errorFields, SafeError } from './errors';
import type { CoreApp, CoreProgress, CoreRoadmap } from './core/types';
import { courseView, currentConcept, otherReady, type Setup } from './courseView';
import { noLog, type Log } from './log';
import { asNotCounted } from './notCounted';
import { programs } from './programs';
import type { desktopState } from './state';
import type { usageStore } from './usage';
import { HELD_BACK, activityView, checkView, exampleRunView, filterReply, hiddenLines, lessonView, roadmapView, trackName, tryView } from './views';

export interface LiveDeps {
  core: CoreApp;
  connect: ReturnType<typeof connector>;
  computer: () => Promise<Computer>;
  state: ReturnType<typeof desktopState>;
  /** The learner's workspace, ~/Codemm by default (O5). */
  ws: string;
  /** The MCP server one job's agent starts, bound to its course and tools (§2, §4.6), and for an author, its gate file (§4.11). */
  server: (course: string | undefined, tools: string[], progress?: string) => McpServer;
  /** A Codemm-owned folder for the gate files author jobs' servers write (§4.11). */
  progressDir?: string;
  /** The app's own executable, which runs Node-script agents. */
  runtime?: string;
  /** A Codemm-owned folder for agents that read their config from the working directory (Cursor). */
  agentDir?: string;
  runJob?: (job: Job) => Promise<JobOutcome>;
  /** What the agents reported using, per course and job kind (usage.ts). */
  usage?: ReturnType<typeof usageStore>;
  /** Lifecycle and detection events only (log.ts). */
  log?: Log;
  /** Resolves once Docker isn't starting any more (§6.1). */
  dockerReady?: () => Promise<void>;
  /** Installs and opens Docker Desktop for the learner (dockerDesktop.ts, §6.1). */
  docker?: { install(): void; open(): Promise<void> };
}

export interface Live extends CodemmApi {
  /** Stops every agent job with its process group, then removes leftover containers (§5). */
  stop(): Promise<void>;
}

/** Setup proposals per setup before the learner gets Stop or Try again (§3.2). */
const PROPOSAL_BOUND = 3;
const problemError = (problem: JobProblem) => new Error({ 'plan-limit': PLAN_LIMIT, 'signed-out': SIGNED_OUT, offline: OFFLINE, failed: AGENT_FAILED, infra: AGENT_FAILED, unstoppable: UNSTOPPABLE }[problem]);
/** Why background work stalled: an infrastructure failure is a plain failure the learner retries. */
const stallOf = (problem: JobProblem = 'failed'): NonNullable<CourseView['stalled']> => (problem === 'infra' ? 'failed' : problem);
/** core store.ts's damaged-record errors: the learner repairs them; a retry can't (§5). */
function repairable(e: unknown): unknown {
  if (kindOf(e) === 'damaged') (e as Error).message = `${REPAIR}\n${(e as Error).message}`;
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
  /** Set once an agent survived its cancel: no agent starts again until Codemm quits (§3.1). */
  let unstoppable = false;
  /** Set once quitting starts: nothing new runs (§5). */
  let stopping = false;
  /** Checks and Try its in flight: their containers belong to this process until they end. */
  const runs = new Set<Promise<unknown>>();
  const tracked = <T>(run: Promise<T>): Promise<T> => {
    runs.add(run);
    return run.finally(() => runs.delete(run));
  };
  /**
   * Runs a container operation once Docker isn't starting, tracked for quitting from the start:
   * quitting waits for it, and an operation still waiting when quitting starts never runs.
   */
  const whenDockerReady = <T>(operation: () => Promise<T>): Promise<T> =>
    tracked(
      dockerReady().then(() => {
        if (stopping) throw new SafeError('Codemm is quitting.');
        return operation();
      }),
    );
  // Containers left by an earlier run of the app, whose owner is gone (§5).
  void core.cleanupLeftovers().catch(() => undefined);
  /** The setup the learner approved, and how it went (§4.1). */
  let setup: { installing?: Promise<void>; approved?: Proposal; problem?: SetupProblem; gateFailures: number; lastGateProblem?: string; installs: number } = { gateFailures: 0, installs: 0 };

  /**
   * The course the learner approved. Learner reads and calls use it, so it stays the course until the learner
   * approves another roadmap. A roadmap saved since then is a draft: the workspace's active course (§4.2).
   */
  const approved = () => d.state.read().approved;
  /** A course's roadmap (the active one by default), or null when there's none. A damaged record isn't "no course": it needs a repair (D14). */
  const roadmapOrNull = (course?: string): CoreRoadmap | null => {
    try {
      return core.getRoadmap(ws, course);
    } catch (e) {
      if (kindOf(e) === 'no-course') return null;
      throw e;
    }
  };
  const installed = (ref: string) => core.listTracks().some((t) => t.track === ref);
  /** A roadmap as shown. Its sources are agent text too, so one that quotes hidden material, or can't be checked, is dropped. */
  const roadmapShown = (r: CoreRoadmap): Roadmap => {
    const view = roadmapView(r, installed(r.track));
    const filter = hidden();
    return { ...view, sources: view.sources.filter((s) => shown(s.title, filter) === s.title && shown(s.url, filter) === s.url) };
  };
  /**
   * The hidden lines of every exercise in a course (the approved one by default), to check agent text against (§2.2).
   * Every exercise, not only the current one: the tutor can open any of them (get_exercise). Null when any can't be
   * loaded: then nothing can be checked, so nothing goes out.
   */
  const hidden = (inCourse?: string): string[] | null => {
    const course = inCourse ?? approved() ?? core.readWorkspace(ws).course;
    if (!course) return [];
    try {
      return hiddenLines(core.listExercises(ws, course).flatMap((e) => core.hiddenMaterial(course, e.exercise)));
    } catch {
      return null;
    }
  };
  /** Agent text as it may be shown: held back when it quotes hidden material, or when that can't be checked. */
  const shown = (text: string, filter: string[] | null) => (filter ? filterReply(text, filter) : HELD_BACK);
  /** The course whose hidden material a job's text is checked against: the one approved when the job starts. */
  const protectedCourse = () => approved() ?? core.readWorkspace(ws).course;
  /**
   * Whether text may be shown, checked against that course's hidden material as it is when the text arrives: an
   * exercise saved while a job runs counts too.
   */
  const safeIn = (course: string | undefined) => (text: string) => !course || shown(text, hidden(course)) === text;

  /** The roadmap not approved yet: the active course, unless it is the approved one. */
  function draft(): CoreRoadmap | null {
    const roadmap = roadmapOrNull();
    return roadmap && roadmap.course !== approved() ? roadmap : null;
  }

  /** Saves the learner's edits to the active roadmap (the draft, if there is one) through core's roadmap rules (§4.2). JSON is YAML. */
  async function saveConcepts(concepts: Concept[]) {
    const current = core.getRoadmap(ws);
    const { goal, track, style, sources } = current;
    await core.saveRoadmap(ws, current.course, JSON.stringify({ goal, track, style, concepts, ...(sources ? { sources } : {}) }), current.course);
  }

  // Every job's progress goes to whoever listens (main sends it to the app window): stages, steps and time (§4.11).
  const jobListeners = new Set<(p: JobProgress) => void>();
  const trackers = new Map<string, JobTracker>();
  const tellJob = (p: JobProgress) => jobListeners.forEach((l) => l(p));

  /**
   * Runs one agent job in a lane: one foreground job and one background queue,
   * each one at a time (§3.2). The job starts only when its turn comes.
   */
  function start(
    key: string, lane: 'fg' | 'bg', kind: JobKind, brief: string, course: string | undefined, done: Job['done'],
    { resume, onSource, concept, retry }: { resume?: string; onSource?: Job['onSource']; concept?: string; retry?: JobProgress['retry'] } = {},
  ): Promise<JobOutcome> {
    const existing = running.get(key);
    if (existing) return existing.outcome;
    if (stopping) return Promise.resolve({ ok: false, problem: 'failed', text: [] });
    if (unstoppable) return Promise.resolve({ ok: false, problem: 'unstoppable', text: [] });
    const stop = new AbortController();
    const job = async (): Promise<JobOutcome> => {
      // A cancelled job, or background work queued behind a stall, never launches.
      if (stop.signal.aborted || (lane === 'bg' && stalled)) return { ok: false, problem: 'failed', text: [] };
      // Nor does any job while an agent Codemm couldn't stop may still run (§3.1).
      if (unstoppable) return { ok: false, problem: 'unstoppable', text: [] };
      const { id, exe, model } = await d.connect.chosen();
      // Again after the lookup: another job may have found its agent unstoppable meanwhile.
      if (unstoppable) return { ok: false, problem: 'unstoppable', text: [] };
      if (stop.signal.aborted) return { ok: false, problem: 'failed', text: [] };
      const began = Date.now();
      log('job-start', { kind, lane, agent: id });
      // The same backstop as tutor replies (§2.2): a step or page that shows hidden material is dropped.
      const tracker = jobTracker(kind, { concept, retry, shows: safeIn(protectedCourse()) });
      trackers.set(key, tracker);
      tellJob(tracker.snapshot());
      // An author's save runs the exercise gates in its server; the server names the running gate in this file.
      const gateFile = kind === 'author' && d.progressDir ? join(d.progressDir, `${tracker.id}.json`) : undefined;
      if (gateFile) mkdirSync(d.progressDir!, { recursive: true });
      const gates = gateFile
        ? watchGates(gateFile, (gate) => {
            tracker.gate(gate);
            tellJob(tracker.snapshot());
          })
        : undefined;
      const outcome = await runJob({
        kind,
        agent: id,
        exe,
        runtime: d.runtime,
        brief,
        server: (tools) => d.server(course, tools, gateFile),
        cwd: ws,
        agentDir: d.agentDir,
        // The learner's model choice, or the recommended one (O6), for every agent with choices.
        model,
        resume,
        signal: stop.signal,
        done,
        blocked: () => unstoppable,
        signedIn: () => d.connect.recheck(id),
        usable: () => d.connect.usable(id),
        // A cancelled or stopped attempt's gate container is removed before a relaunch or the end (§5).
        cleanup: () => core.cleanupLeftovers(),
        onEvent: (e) => {
          tracker.event(e);
          // A save that ended leaves its last gate in the file; the next save starts from none.
          if (gates && e.type === 'tool_result' && !tracker.saving()) gates.clear();
          tellJob(tracker.snapshot());
        },
        onRelaunch: () => {
          tracker.relaunch();
          // An attempt that crashed mid-save left its last gate behind.
          gates?.clear();
          tellJob(tracker.snapshot());
        },
        onSource,
        onUsage: (u) => recordUsage(course, kind, u),
      }).finally(() => {
        gates?.stop();
        trackers.delete(key);
        tellJob({ ...tracker.snapshot(), ended: true });
      });
      if (outcome.problem === 'unstoppable') unstoppable = true;
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
  function background(
    key: string, kind: JobKind, brief: string, course: string, done: Job['done'],
    { lane = 'bg', concept, retry }: { lane?: 'fg' | 'bg'; concept?: string; retry?: JobProgress['retry'] } = {},
  ) {
    if (stopping || stalled || running.has(key)) return;
    const outcome = start(key, lane, kind, brief, course, done, { concept, retry });
    const controller = running.get(key)?.stop;
    // The first stall is the one the learner sees.
    outcome
      .then((o) => {
        if (!o.ok && !controller?.signal.aborted) stalled ??= stallOf(o.problem);
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
   * activity. Codemm's own steps call it, so reopening a lesson or an activity starts no agent (D9).
   * The one read that calls it is a course read that finds a review the clock made due (core §7).
   */
  function schedule() {
    try {
      const course = approved();
      const roadmap = course ? roadmapOrNull(course) : null;
      if (!roadmap) return;
      const progress = core.progress(ws, roadmap.course);
      const state = progress.next.kind === 'setup' ? setupState(progress) : ({ state: 'ready' } as const);
      if (state.state === 'proposing') {
        const ref = progress.track;
        const before = new Set(core.listProposals().map((p) => p.digest));
        // Done once it proposed: the proposal may already be gone if the learner approved it and its gates failed.
        const installs = setup.installs;
        const proposed = () => setup.installs > installs || core.listProposals().some((p) => p.track === ref && !before.has(p.digest));
        // Another proposal after one failed its gates is a retry, within the bound (§3.2).
        const retry = setup.gateFailures > 0 ? { attempt: setup.gateFailures + 1, of: PROPOSAL_BOUND } : undefined;
        background(`setup:${progress.course}`, 'setup', briefs.setup(ref, roadmap.style, setup.lastGateProblem), progress.course, proposed, { retry });
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
      background(`lesson:${course}:${concept.id}`, 'lesson', briefs.lesson(concept.id, concept.title), course, () => lessons() > 0, { lane, concept: concept.id });
    }
    if (ready && progress.next.kind === 'author') {
      // Done only by a new exercise for this concept at the requested difficulty (§3.2).
      // The agent reads its target and the track's contract from next_step (core JOB_BRIEFS.author).
      const { difficulty } = progress.next;
      const before = new Set(core.listExercises(ws, course).map((e) => e.exercise));
      const made = () => core.listExercises(ws, course).some((e) => !before.has(e.exercise) && e.concepts.includes(concept.id) && e.difficulty === difficulty);
      background(`author:${course}:${concept.id}:${difficulty}`, 'author', briefs.author(), course, made, { concept: concept.id });
    }
  }

  async function foreground(key: string, kind: JobKind, brief: string, course: string | undefined, done: Job['done'], resume?: string) {
    const outcome = await start(key, 'fg', kind, brief, course, done, { resume });
    if (!outcome.ok && outcome.problem) throw problemError(outcome.problem);
    return outcome;
  }

  /** A roadmap change may move the course to another track: its setup and author jobs stop, and the old track's proposals go (§4.2). */
  async function roadmapJob(course: string, brief: string, done: (before: string) => Job['done']) {
    const before = core.getRoadmap(ws, course);
    const saved = JSON.stringify(before);
    await cancel((key) => key === `setup:${course}` || key.startsWith(`author:${course}:`));
    const outcome = await foreground(`roadmap:${course}`, 'roadmap', brief, course, done(saved));
    const after = core.getRoadmap(ws, course);
    if (after.track !== before.track) {
      await core.dropProposal(before.track);
      setup = { gateFailures: 0, installs: 0 };
    }
    return { outcome, changed: JSON.stringify(after) !== saved, after };
  }

  /** The saved activity for a concept, even when the next step recommends something else (stuck, §3.2). */
  function exerciseFor(concept: string, course: string): string | undefined {
    const next = core.progress(ws, course).next;
    if ((next.kind === 'practice' || next.kind === 'review') && next.concept === concept) return next.exercise;
    return core.listExercises(ws, course).filter((e) => e.concepts.includes(concept)).sort((a, b) => b.created.localeCompare(a.created))[0]?.exercise;
  }

  // Work the course still needs when the app starts.
  queueMicrotask(schedule);

  // Check progress goes to whoever listens (main sends it to the app window): the phase and counts, and visible results.
  const progressListeners = new Set<(p: CheckProgress) => void>();
  // A visible test's result passes on, field by field; a hidden event never carries one.
  const finished = ({ name, status, message, actual }: NonNullable<CheckProgress['test']>) => ({ name, status, ...(message !== undefined ? { message } : {}), ...(actual !== undefined ? { actual } : {}) });
  const progressOf = (run?: string) => ({ phase, done, total, test }: CheckProgress) =>
    progressListeners.forEach((l) => l({ ...(run ? { run } : {}), phase, done, total, ...(phase === 'visible' && test ? { test: finished(test) } : {}) }));

  /** What a job's agent reported using, under its course and kind (§4.12). Never stops the job. */
  function recordUsage(course: string | undefined, kind: Job['kind'], u: Parameters<NonNullable<Job['onUsage']>>[0]) {
    if (!d.usage || !course) return;
    try {
      d.usage.record(course, kind, u, u.session);
    } catch (e) {
      log('usage-error', errorFields(e));
    }
  }

  // Run's programs, by run id (§4.10): programs.ts.
  const programRuns = programs({ whenDockerReady, log });

  /** Research jobs that ended but whose sources aren't saved yet. */
  const finishing = new Set<string>();

  /** After research saves the roadmap, the pages it read join the agent's own sources (§4.9), at most 10. */
  async function addReads(course: string, reads: { title: string; url: string }[]) {
    const r = core.getRoadmap(ws, course);
    const sources = [...(r.sources ?? [])];
    for (const read of reads) if (!sources.some((s) => s.url === read.url)) sources.push(read);
    if (sources.length === (r.sources ?? []).length) return;
    const { goal, track, style, concepts } = r;
    await core.saveRoadmap(ws, course, JSON.stringify({ goal, track, style, concepts, sources: sources.slice(0, 10) }), course);
  }

  const api: Live = {
    onCheckProgress(listener) {
      progressListeners.add(listener);
      return () => void progressListeners.delete(listener);
    },
    onJobProgress(listener) {
      jobListeners.add(listener);
      return () => void jobListeners.delete(listener);
    },
    async jobProgress() {
      return [...trackers.values()].map((t) => t.snapshot());
    },
    onRunOutput: (listener) => programRuns.onOutput(listener),
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
    async installAgent(id) {
      log('agent-install', { agent: id });
      await d.connect.install(id);
    },
    async signIn(id) {
      log('agent-sign-in', { agent: id });
      await d.connect.signIn(id);
    },
    async chooseModel(id, model) {
      const agent = await d.connect.chooseModel(id, model);
      log('model', { agent: id, model });
      return agent;
    },
    async installDocker() {
      log('docker-install', {});
      d.docker?.install();
    },
    async openDocker() {
      await d.docker?.open();
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
        finishing.delete(key);
        if (!outcome.ok) {
          if (outcome.problem && outcome.problem !== 'failed' && outcome.problem !== 'infra') throw problemError(outcome.problem);
          return { state: 'failed' };
        }
        return { state: 'done', roadmap: roadmapShown(core.getRoadmap(ws)) };
      }
      if (!running.has(key) && !finishing.has(key)) {
        await d.connect.chosen();
        // A new course, on a server that saves only it (§4.6).
        const course = courseId(goal.topic, Date.now());
        const reads: { title: string; url: string }[] = [];
        // The same backstop as tutor replies (§2.2): a page that shows hidden material is no source.
        const safe = safeIn(protectedCourse());
        const onSource = (source: { title: string; url: string }) => {
          if (safe(source.url)) reads.push({ title: source.title.slice(0, 120), url: source.url });
        };
        // Research counts as running until its sources are saved, so a poll meanwhile starts no second agent.
        finishing.add(key);
        start(key, 'fg', 'research', briefs.research(course, goal.topic, goal.known, goal.depth), course, () => roadmapOrNull()?.course === course, { onSource })
          .then(async (o) => {
            if (o.ok) {
              // Quitting waits for this save, like any other run (stop()).
              const saving = addReads(course, reads).catch((e: Error) => log('sources-error', errorFields(e)));
              runs.add(saving);
              await saving.finally(() => runs.delete(saving));
            }
            outcomes.set(key, o);
          })
          .catch((e: Error) => outcomes.set(key, { ok: false, problem: e.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed', text: [] }));
      }
      return { state: 'running' };
    },

    async reviseRoadmap(concepts, request) {
      await saveConcepts(concepts);
      const course = core.getRoadmap(ws).course;
      // Checked against the course approved when the change starts, with any exercise saved meanwhile.
      const protect = protectedCourse();
      const { outcome, changed, after } = await roadmapJob(course, briefs.roadmap(request), (before) => (turn) => turn.ok || JSON.stringify(core.getRoadmap(ws, course)) !== before);
      schedule();
      const filter = protect ? hidden(protect) : [];
      return { roadmap: roadmapShown(after), changed, text: outcome.text.map((t) => shown(t, filter)).join('\n\n') };
    },

    async approve(concepts) {
      await saveConcepts(concepts);
      const course = core.getRoadmap(ws).course;
      d.state.update((s) => ({ ...s, approved: course }));
      stalled = undefined;
      setup = { gateFailures: 0, installs: 0 };
      schedule();
    },

    async draft() {
      const roadmap = draft();
      return roadmap && roadmapShown(roadmap);
    },

    async saveDraft(concepts) {
      if (!draft()) throw new SafeError('No roadmap to edit.');
      await saveConcepts(concepts);
    },

    /** A read: it starts nothing (D9). */
    async course() {
      const course = approved();
      const roadmap = course ? roadmapOrNull(course) : null;
      if (!roadmap) return null;
      const progress = core.progress(ws, roadmap.course);
      // The clock, not a learner action, made this review due, so nothing else would start its exercise (core §7).
      if (progress.next.kind === 'author' && progress.next.review) schedule();
      const state = progress.next.kind === 'setup' ? setupState(progress) : ({ state: 'ready' } as const);
      const jobs = new Set([...running.keys()].map((k) => k.replace(`:${roadmap.course}`, '')));
      const view = courseView(progress, core.listLessons(ws, roadmap.course), state, jobs);
      return stalled ? { ...view, stalled } : view;
    },

    async install(digest) {
      const ref = core.progress(ws, approved()).track;
      // This install's own setup: approving another course replaces `setup`, and this one must not touch that.
      const mine = setup;
      const proposal = mine.approved?.digest === digest ? mine.approved : latestProposal(ref);
      if (!proposal || proposal.digest !== digest) throw new SafeError('The setup changed. Look at it again.');
      mine.approved = proposal;
      mine.problem = undefined;
      mine.installs++;
      // Codemm builds and checks the approved files: the setup's later stages (§4.11).
      const tracker = jobTracker('setup');
      trackers.set(`install:${ref}`, tracker);
      tracker.reach(1);
      tellJob(tracker.snapshot());
      mine.installing = dockerReady()
        .then(() =>
          core.installProposal(ref, digest, (p) => {
            // Counts only: the build's steps, then its checks.
            if (p.phase === 'building') tracker.reach(1, { done: p.done, total: p.total });
            else tracker.reach(2);
            tellJob(tracker.snapshot());
          }),
        )
        .then(() => {
          mine.approved = undefined;
        })
        .catch(async (e: Error) => {
          // This computer's problems keep the proposal for Try again; nothing is recorded and no agent runs (§6.1).
          const kind = infraOf(e);
          log('setup-failed', { problem: kind ?? 'gates' });
          if (kind) {
            mine.problem = kind;
            return;
          }
          mine.approved = undefined;
          mine.gateFailures++;
          mine.lastGateProblem = e.message;
          // The next proposal is asked for only once this one is gone (it waits for the track lock).
          await core.dropProposal(ref).catch(() => undefined);
        })
        .finally(() => {
          trackers.delete(`install:${ref}`);
          tellJob({ ...tracker.snapshot(), ended: true });
          mine.installing = undefined;
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
      return lessonView(core.getLesson(ws, id, approved()));
    },

    async runExample(lessonId, index) {
      try {
        return exampleRunView(await whenDockerReady(() => core.runExample(ws, lessonId, index, approved())));
      } catch (e) {
        return asNotCounted(e, log, 'example', 'not-run');
      }
    },
    saveNotes: (id, notes) => core.saveNotes(ws, id, notes, approved()),
    async markRead(id) {
      await core.markLessonRead(ws, id, approved());
      schedule();
    },

    async activity(concept) {
      const course = core.getRoadmap(ws, approved()).course;
      const slug = exerciseFor(concept, course);
      if (!slug) throw new SafeError('This activity isn’t ready yet.');
      const exercise = await core.getExercise(ws, slug, course);
      return activityView(exercise, core.readLearnerFiles(ws, slug, course), concept);
    },

    async saveFile(activityId, path, text, digest) {
      try {
        return (await core.writeLearnerFile(ws, activityId, path, text, digest, approved())).digest;
      } catch (e) {
        if (kindOf(e) === 'changed') throw new Error(CHANGED);
        throw e;
      }
    },

    async tryIt(activityId, run) {
      try {
        return tryView(await whenDockerReady(() => core.testExercise(ws, activityId, approved(), progressOf(run))));
      } catch (e) {
        return asNotCounted(e, log, 'try', 'not-counted');
      }
    },

    runProgram: (activityId, run) => programRuns.start(run, (output, options) => core.runInteractive(ws, activityId, approved(), output, options)),
    runExampleLive: (lessonId, index, run) => programRuns.start(run, (output, options) => core.runExampleLive(ws, lessonId, index, approved(), output, options)),
    sendRunInput: (run, text) => programRuns.input(run, text),
    stopRun: (run) => programRuns.stop(run),

    async check(activityId, run) {
      try {
        const course = approved();
        const view = await whenDockerReady(() => core.checkExercise(ws, activityId, course, progressOf(run)));
        const concepts = core.listExercises(ws, course).find((e) => e.exercise === activityId)?.concepts ?? [];
        const progress = core.progress(ws, course);
        const state = progress.concepts.find((c) => concepts.includes(c.id));
        // A graded check can move the course on: the next topic's lesson and activity.
        schedule();
        return checkView(view, { stuck: state?.stuck ?? false, mastered: state?.mastered ?? false, later: otherReady(progress, concepts) });
      } catch (e) {
        return asNotCounted(e, log, 'check', 'not-counted');
      }
    },

    async ask(place, text) {
      const { id } = await d.connect.chosen();
      const course = core.getRoadmap(ws, approved()).course;
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
      // Checked against this turn's course, whatever course is approved by now.
      const filter = hidden(course);
      return outcome.text.map((t) => ({ from: 'codemm' as const, text: shown(t, filter) }));
    },

    async skip(concept) {
      await core.skip(ws, concept, approved());
      schedule();
    },

    async easier(concept) {
      const course = core.getRoadmap(ws, approved()).course;
      const title = core.getRoadmap(ws, course).concepts.find((c) => c.id === concept)?.title ?? concept;
      await roadmapJob(course, briefs.easier(concept, title), (before) => () => JSON.stringify(core.getRoadmap(ws, course)) !== before);
      schedule();
    },

    async rebuild(ref) {
      await core.rebuildTrack(ref);
    },

    // The course on screen: the approved one, as course() shows, not a draft being researched.
    async usage() {
      const course = approved();
      return course && d.usage ? d.usage.course(course) : null;
    },
    // Updates are main's (updates.ts), which answers these in place of live.
    update: async () => ({ kind: 'none' }),
    restartToUpdate: async () => undefined,

    async stop() {
      stopping = true;
      log('quit', { jobs: running.size, runs: runs.size });
      programRuns.stopAll();
      await cancel(() => true);
      await Promise.all([...runs].map((r) => r.catch(() => undefined)));
      await core.cleanupLeftovers().catch(() => undefined);
    },
  };
  // Every call: a damaged record says so, with core's guidance. (onCheckProgress subscribes; it isn't a call.)
  for (const name of Object.keys(api) as (keyof Live)[]) {
    if (name === 'onCheckProgress' || name === 'onJobProgress' || name === 'onRunOutput') continue;
    const call = api[name] as (...args: unknown[]) => Promise<unknown>;
    (api as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => call.apply(api, args).catch((e: unknown) => Promise.reject(repairable(e)));
  }
  return api;
}
