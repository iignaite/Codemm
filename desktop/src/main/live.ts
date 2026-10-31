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
  type Agent,
  type AgentId,
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
import { asNotCounted, rebuildFailure } from './notCounted';
import { programs } from './programs';
import { coursesOf, type desktopState } from './state';
import type { usageStore } from './usage';
import { HELD_BACK, activityView, checkView, exampleRunView, filterReply, hiddenLines, lessonView, roadmapView, setupWhy, trackName, tryView } from './views';

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
  /** Brings PATH up to date, on Windows from the registry (livePath.ts, §3.1): agents, Docker and core's docker calls rely on it. */
  livePath?: () => Promise<void>;
  /**
   * Installs and opens Docker Desktop for the learner, Windows Update when Windows is too old for it, and Windows'
   * restart when WSL needs one (dockerDesktop.ts, §6.1).
   */
  docker?: { install(): void; open(): Promise<void>; windowsUpdate(): Promise<void>; restartWindows(): Promise<void> };
}

export interface Live extends CodemmApi {
  /** Stops every agent job with its process group, then removes leftover containers (§5). */
  stop(): Promise<void>;
}

/** Setup proposals per setup before the learner gets Stop or Try again (§3.2). */
const PROPOSAL_BOUND = 5;
const problemError = (problem: JobProblem) =>
  new Error({ 'plan-limit': PLAN_LIMIT, 'signed-out': SIGNED_OUT, offline: OFFLINE, failed: AGENT_FAILED, infra: AGENT_FAILED, rebuild: AGENT_FAILED, docker: AGENT_FAILED, 'docker-busy': AGENT_FAILED, 'docker-failed': AGENT_FAILED, 'docker-disk': AGENT_FAILED, disk: AGENT_FAILED, wasi: AGENT_FAILED, 'wasi-seal': AGENT_FAILED, unstoppable: UNSTOPPABLE }[problem]);
type Stall = NonNullable<CourseView['stalled']>;
/** Stalls Docker caused, which end once Check this computer passes (§4.13). */
const DOCKER_STALLS: Stall[] = ['docker', 'docker-busy', 'docker-failed'];
/**
 * Stalls that end once a step running the course's code works: Docker's, its disk's, this computer's disk, the
 * track's image, and a WASI track's wasmtime or read-only files.
 */
const CONTAINER_STALLS: Stall[] = [...DOCKER_STALLS, 'docker-disk', 'disk', 'rebuild', 'wasi', 'wasi-seal'];
/** Why background work stalled: Docker and the disk say so; another infrastructure failure is a plain one the learner retries. */
const stallOf = (problem: JobProblem = 'failed'): Stall => (problem === 'infra' ? 'failed' : problem);
/** core store.ts's damaged-record errors: the learner repairs them; a retry can't (§5). */
function repairable(e: unknown): unknown {
  if (kindOf(e) === 'damaged') (e as Error).message = `${REPAIR}\n${(e as Error).message}`;
  return e;
}

interface Running {
  outcome: Promise<JobOutcome>;
  stop: AbortController;
}

/** An agent's session, which only that agent can continue. */
type AgentSession = { agent: AgentId; id: string };

/** A course's setup: the proposal the learner approved, and how it went (§4.1). */
interface SetupRun {
  installing?: Promise<void>;
  approved?: Proposal;
  problem?: SetupProblem;
  gateFailures: number;
  lastGateProblem?: string;
  /**
   * The last setup agent's session: a proposal after a gate failure continues it, so the agent fixes its own files.
   * Only the same agent can continue it, and Cursor keeps chats per job folder, which the course's server names.
   */
  session?: AgentSession & { course: string };
  installs: number;
}

/** Runs work one piece at a time, each once the one before has settled. */
function turns() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = last.then(work, work);
    last = run.catch(() => undefined);
    return run;
  };
}

export function createLive(d: LiveDeps): Live {
  const { core, ws } = d;
  const runJob = d.runJob ?? realRunJob;
  const log = d.log ?? noLog;
  const dockerReady = d.dockerReady ?? (async () => {});
  const livePath = d.livePath ?? (async () => {});
  const briefs = briefsFrom(core.JOB_BRIEFS);
  const running = new Map<string, Running>();
  const reviewing = new Set<string>();
  /**
   * One-at-a-time queues, by name (§3.2, §4.13): each course's foreground lane, background queue and tutor turns
   * (`fg:`, `bg:`, `tutor:` and the course), and across courses, track builds and author jobs: Docker-heavy work.
   */
  const queues = new Map<string, ReturnType<typeof turns>>();
  const queue = (name: string) => {
    let q = queues.get(name);
    if (!q) queues.set(name, (q = turns()));
    return q;
  };
  const outcomes = new Map<string, JobOutcome>();
  /** The course each activity was opened in: a save that arrives after a switch still goes there (§4.13). */
  const openedIn = new Map<string, string>();
  /** Background work that stopped, per course, and why: one course's stall never stops another's (§4.13). */
  const stalls = new Map<string, Stall>();
  /** Per course, the concept whose lesson job's failure is the stall: its row stays, with Try again. */
  const failedLessons = new Map<string, string>();
  /** Per course, the kind of background work whose stall it is. */
  const stalledWork = new Map<string, NonNullable<CourseView['stalledWork']>>();
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
   * Runs a track's operation once Docker isn't starting, tracked for quitting from the start: quitting waits for
   * it, and an operation still waiting when quitting starts never runs. A WASI track's never waits for Docker.
   */
  const whenReady = <T>(track: string | undefined, operation: () => Promise<T>): Promise<T> =>
    tracked(
      (onWasi(track) ? Promise.resolve() : dockerReady()).then(() => {
        if (stopping) throw new SafeError('Codemm is quitting.');
        return operation();
      }),
    );
  // Containers left by an earlier run of the app, whose owner is gone (§5).
  void core.cleanupLeftovers().catch(() => undefined);
  /** Each track's setup (§4.1), shared by the courses on it (§4.13). */
  const setups = new Map<string, SetupRun>();
  const setupOf = (track: string) => {
    let run = setups.get(track);
    if (!run) setups.set(track, (run = { gateFailures: 0, installs: 0 }));
    return run;
  };

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
  /** Whether a track runs on the WASI engine (core §4.5), as core names it: the installed track, else its proposal. */
  const onWasi = (ref: string | undefined): boolean => {
    if (!ref) return false;
    try {
      const track = core.listTracks().find((t) => t.track === ref);
      if (track) return track.engine === 'wasi';
      return core.listProposals().find((p) => p.track === ref)?.engine === 'wasi';
    } catch {
      return false;
    }
  };
  /** A course's track (the active one's by default, as core's calls); none for a course whose roadmap can't be read. */
  const trackOf = (course?: string) => {
    try {
      return roadmapOrNull(course)?.track;
    } catch {
      return undefined;
    }
  };
  /** The learner's courses on a track, and `course`: they share its setup (§4.13). */
  const onTrack = (ref: string, course: string) => [...new Set([course, ...coursesOf(d.state.read())])].filter((c) => {
    const r = roadmapOrNull(c);
    return r?.track === ref && r.style !== 'none';
  });
  /** A course's name: the words typed for a course from before titles (W-5), kept as it was, else the agent's title, else its goal. */
  const nameOf = (r: CoreRoadmap) => d.state.read().names?.[r.course] ?? r.title ?? r.goal;
  /** A roadmap as shown. Its sources are agent text too, so one that quotes hidden material, or can't be checked, is dropped. */
  const roadmapShown = (r: CoreRoadmap): Roadmap => {
    const view = roadmapView(r, Boolean(r.track && installed(r.track)), nameOf(r));
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

  /** The roadmap not approved yet: the active course, unless it is under review or one of the learner's courses. */
  function draft(): CoreRoadmap | null {
    const roadmap = roadmapOrNull();
    return roadmap && !reviewing.has(roadmap.course) && !coursesOf(d.state.read()).includes(roadmap.course) ? roadmap : null;
  }

  /** Saves the learner's edits to the active roadmap (the draft, if there is one) through core's roadmap rules (§4.2). JSON is YAML. */
  async function saveConcepts(concepts: Concept[]) {
    const current = core.getRoadmap(ws);
    // The review's own save would replace the learner's edits.
    if (reviewing.has(current.course)) throw new SafeError('The roadmap is still being checked. Try again in a moment.');
    const { title, goal, track, style, sources } = current;
    const byId = new Map(current.concepts.map((c) => [c.id, c]));
    const merged = concepts.map(({ id, title, requires }) => {
      const { practice, pitfalls, refs } = byId.get(id) ?? {};
      return { id, title, requires, practice, pitfalls, refs };
    });
    // JSON leaves out optional fields that are undefined.
    await core.saveRoadmap(ws, current.course, JSON.stringify({ title, goal, track, style, concepts: merged, ...(sources ? { sources } : {}) }), current.course);
  }

  // Every job's progress goes to whoever listens (main sends it to the app window): stages, steps and time (§4.11).
  const jobListeners = new Set<(p: JobProgress) => void>();
  /** Who hears a job: a course's own jobs, or a track's setup, which every course on that track hears. */
  type Audience = { course?: string; track?: string };
  const trackers = new Map<string, { tracker: JobTracker; audience: Audience }>();
  /** The window hears the jobs of the course on screen, research and the draft, but not another course's (§4.13). */
  const heard = ({ course, track }: Audience) => {
    const s = d.state.read();
    if (track) return s.approved !== undefined && onTrack(track, s.approved).includes(s.approved);
    return !course || course === s.approved || !coursesOf(s).includes(course);
  };
  const tellJob = (p: JobProgress, audience: Audience) => {
    if (heard(audience)) jobListeners.forEach((l) => l(p));
  };

  /**
   * Runs one agent job in a lane: one foreground job and one background queue,
   * each one at a time (§3.2). The job starts only when its turn comes.
   */
  function start(
    key: string, lane: 'fg' | 'bg', kind: JobKind, brief: string, course: string | undefined, done: Job['done'],
    { resume, onSource, concept, retry, settled, track, onSession }: {
      /** A session to continue: a tutor's, or another job's, which only its own agent continues. */
      resume?: string | AgentSession; onSource?: Job['onSource']; concept?: string; retry?: JobProgress['retry'];
      /** Hears the session the job's agent left, failed or not. */
      onSession?: (session: AgentSession) => void;
      /** A track's setup: every course on the track hears its progress. */
      track?: string;
      /** Runs as the job ends, before its queue moves on: background work records its stall here. */
      settled?: (result: JobOutcome | Error) => void;
    } = {},
  ): Promise<JobOutcome> {
    const existing = running.get(key);
    if (existing) return existing.outcome;
    if (stopping) return Promise.resolve({ ok: false, problem: 'failed', text: [] });
    if (unstoppable) {
      // Background work that won't start still stalls its course, so the learner sees why (§3.1).
      const outcome: JobOutcome = { ok: false, problem: 'unstoppable', text: [] };
      settled?.(outcome);
      return Promise.resolve(outcome);
    }
    const stop = new AbortController();
    const audience: Audience = track ? { track } : { course };
    let launched = false;
    const job = async (): Promise<JobOutcome> => {
      launched = true;
      // A cancelled job, or background work queued behind its course's stall, never launches.
      if (stop.signal.aborted || (lane === 'bg' && course !== undefined && stalls.has(course))) return { ok: false, problem: 'failed', text: [] };
      // Nor does any job while an agent Codemm couldn't stop may still run (§3.1).
      if (unstoppable) return { ok: false, problem: 'unstoppable', text: [] };
      // The agent, and the Codemm server it starts, inherit PATH as it is now.
      await livePath();
      const { id, exe, model } = await d.connect.chosen();
      // Again after the lookup: another job may have found its agent unstoppable meanwhile.
      if (unstoppable) return { ok: false, problem: 'unstoppable', text: [] };
      if (stop.signal.aborted) return { ok: false, problem: 'failed', text: [] };
      const began = Date.now();
      log('job-start', { kind, lane, agent: id });
      // The same backstop as tutor replies (§2.2): a step or page that shows hidden material is dropped.
      const tracker = jobTracker(kind, { concept, retry, shows: safeIn(protectedCourse()) });
      trackers.set(key, { tracker, audience });
      tellJob(tracker.snapshot(), audience);
      // An author's save runs the exercise gates in its server; the server names the running gate in this file.
      const gateFile = kind === 'author' && d.progressDir ? join(d.progressDir, `${tracker.id}.json`) : undefined;
      if (gateFile) mkdirSync(d.progressDir!, { recursive: true });
      const gates = gateFile
        ? watchGates(gateFile, (gate) => {
            tracker.gate(gate);
            tellJob(tracker.snapshot(), audience);
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
        resume: typeof resume === 'string' ? resume : resume?.agent === id ? resume.id : undefined,
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
          tellJob(tracker.snapshot(), audience);
        },
        onRelaunch: () => {
          tracker.relaunch();
          // An attempt that crashed mid-save left its last gate behind.
          gates?.clear();
          tellJob(tracker.snapshot(), audience);
        },
        onSource,
        onUsage: (u) => recordUsage(course, kind, u),
      }).finally(() => {
        gates?.stop();
        trackers.delete(key);
        tellJob({ ...tracker.snapshot(), ended: true }, audience);
      });
      if (outcome.session) onSession?.({ agent: id, id: outcome.session });
      if (outcome.problem === 'unstoppable') unstoppable = true;
      log('job-end', { kind, ok: outcome.ok, problem: outcome.problem, cause: outcome.cause, cancelled: stop.signal.aborted || undefined, ms: Date.now() - began });
      return outcome;
    };
    // An author job's save builds and checks the exercise in containers, so author jobs take turns across courses. One
    // cancelled while it waits for that turn ends at once, so stopping it never waits for another course's job.
    const cancelled = () =>
      new Promise<JobOutcome>((resolve) => stop.signal.addEventListener('abort', () => launched || resolve({ ok: false, problem: 'failed', text: [] }), { once: true }));
    const turn = kind === 'author' ? () => (stop.signal.aborted ? job() : Promise.race([queue('authors')(job), cancelled()])) : job;
    const run = () =>
      turn().then(
        (o) => (settled?.(o), o),
        (e: Error) => {
          settled?.(e);
          throw e;
        },
      );
    const outcome = queue(`${lane}:${course ?? ''}`)(run).finally(() => running.delete(key));
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
    { lane = 'bg', concept, retry, track, resume, onSession }: {
      lane?: 'fg' | 'bg'; concept?: string; retry?: JobProgress['retry']; track?: string; resume?: AgentSession;
      onSession?: (session: AgentSession) => void;
    } = {},
  ) {
    if (stopping || stalls.has(course) || running.has(key)) return;
    // A track's setup belongs to every course on the track when it ends: they stall and move on together.
    const courses = () => (track ? onTrack(track, course) : [course]);
    // The first stall is the one the learner sees, recorded before the queue moves on, so nothing queued behind it
    // launches. A lesson its agent couldn't write says so on its own row; one whose agent or server didn't start (infra)
    // still offers Check your agent.
    const stall = (problem: JobProblem) =>
      courses().forEach((c) => {
        if (stalls.has(c)) return;
        const lesson = kind === 'lesson' && problem === 'failed';
        stalls.set(c, lesson ? 'lesson' : stallOf(problem));
        if (kind === 'setup' || kind === 'lesson' || kind === 'author') stalledWork.set(c, kind);
        if (lesson && concept) failedLessons.set(c, concept);
      });
    const settled = (r: JobOutcome | Error) => {
      if (r instanceof Error) {
        log('job-error', { job: kind, ...errorFields(r) });
        stall(r.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed');
      } else if (!r.ok && !running.get(key)?.stop.signal.aborted) stall(r.problem ?? 'failed');
    };
    // A finished job can make its course's next one due: the lesson before the activity, a proposal after gates.
    start(key, lane, kind, brief, course, done, { concept, retry, settled, track, resume, onSession }).then((o) => o.ok && courses().forEach((c) => schedule(c)), () => undefined);
  }

  /** Ends a course's stall and starts the work it still needs. */
  function resume(course: string | undefined) {
    if (!course) return;
    stalls.delete(course);
    failedLessons.delete(course);
    stalledWork.delete(course);
    schedule(course);
  }

  /** An agent is connected again, by Connect or by signing in elsewhere: every course a sign-out stalled starts again. */
  function signedInAgain(agents: Agent[]) {
    if (agents.some((a) => a.state === 'connected')) for (const [course, why] of [...stalls]) if (why === 'signed-out') resume(course);
  }

  /** A Docker step of a course worked: a stall Docker, a disk or the track's image caused is over (§4.13). */
  function dockerWorked(course: string | undefined) {
    const why = course ? stalls.get(course) : undefined;
    if (why && CONTAINER_STALLS.includes(why)) resume(course);
  }

  function latestProposal(ref: string, setup: SetupRun): Proposal | undefined {
    const latest = core.listProposals().filter((p) => p.track === ref).sort((a, b) => b.created.localeCompare(a.created))[0];
    const retry = setup.gateFailures > 0;
    return latest && { digest: latest.digest, retry, ...(retry ? { why: setupWhy(setup.lastGateProblem) } : {}), files: Object.entries(latest.files).map(([path, text]) => ({ path, text })) };
  }

  /** One consent before setup (§4.1): propose, wait for the learner, build exactly what they saw. */
  function setupState(progress: CoreProgress): Setup {
    const ref = progress.next.kind === 'setup' ? progress.next.track : progress.track;
    if (!ref || progress.style === 'none') return { state: 'ready' };
    const setup = setupOf(ref);
    if (installed(ref)) return { state: 'ready' };
    if (setup.installing) return { state: 'installing' };
    // A fixable failure keeps the approved proposal, so Try again builds the same files without asking again.
    if (setup.problem) return { state: 'failed', problem: setup.problem, ...(setup.approved ? { proposal: setup.approved } : {}) };
    if (setup.gateFailures >= PROPOSAL_BOUND) return { state: 'failed', problem: 'gates' };
    const proposal = latestProposal(ref, setup);
    if (proposal) return { state: 'consent', proposal };
    return { state: 'proposing' };
  }

  /**
   * Starts the background work the course needs: a setup proposal, the current topic's lesson and
   * activity, for a course (the one on screen by default). Codemm's own steps call it, so reopening a lesson or an
   * activity starts no agent (D9). The one read that calls it is a course read that finds a review the clock made due
   * (core §7).
   */
  function schedule(course = approved()) {
    try {
      const roadmap = course ? roadmapOrNull(course) : null;
      if (!roadmap) return;
      const progress = core.progress(ws, roadmap.course);
      const state = progress.next.kind === 'setup' ? setupState(progress) : ({ state: 'ready' } as const);
      if (state.state === 'proposing' && progress.next.kind === 'setup') {
        const ref = progress.next.track;
        const setup = setupOf(ref);
        const before = new Set(core.listProposals().map((p) => p.digest));
        // Done once it proposed: the proposal may already be gone if the learner approved it and its gates failed.
        const installs = setup.installs;
        const proposed = () => setup.installs > installs || core.listProposals().some((p) => p.track === ref && !before.has(p.digest));
        // Another proposal after one failed its gates is a retry, within the bound (§3.2).
        const retry = setup.gateFailures > 0 ? { attempt: setup.gateFailures + 1, of: PROPOSAL_BOUND } : undefined;
        // The agent can't build or run anything itself, so after a gate failure it continues its own session: it sees the
        // files it proposed and fixes them, rather than writing a new track from the failure alone.
        background(`setup:${ref}`, 'setup', briefs.setup(ref, roadmap.style, setup.lastGateProblem, roadmap.concepts.map((c) => c.title)), progress.course, proposed, {
          retry, track: ref, ...(retry && setup.session?.course === progress.course ? { resume: setup.session } : {}),
          onSession: (session) => (setup.session = { ...session, course: progress.course }),
        });
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
    if (progress.next.kind === 'learn' ? progress.next.lesson === null : lessons() === 0) {
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
    // The old track's setup belongs to this course alone unless another of the learner's courses is on it (§4.13).
    const shared = coursesOf(d.state.read()).some((c) => c !== course && roadmapOrNull(c)?.track === before.track);
    await cancel((key) => (!shared && key === `setup:${before.track}`) || key.startsWith(`author:${course}:`));
    const outcome = await foreground(`roadmap:${course}`, 'roadmap', brief, course, done(saved));
    const after = core.getRoadmap(ws, course);
    if (before.track && after.track !== before.track && !shared) {
      await core.dropProposal(before.track);
      setups.delete(before.track);
    }
    return { outcome, changed: JSON.stringify(after) !== saved, after };
  }

  /** The saved activity for a concept, even when the next step recommends something else (stuck, §3.2). */
  function exerciseFor(concept: string, course: string): string | undefined {
    const next = core.progress(ws, course).next;
    if ((next.kind === 'practice' || next.kind === 'review') && next.concept === concept) return next.exercise;
    return core.listExercises(ws, course).filter((e) => e.concepts.includes(concept)).sort((a, b) => b.created.localeCompare(a.created))[0]?.exercise;
  }

  // Work the course on screen still needs when the app starts; another course's starts when the learner opens it.
  queueMicrotask(() => schedule());

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

  // Run's programs, by run id (§4.10): programs.ts. They run on the approved course's track, so wait for Docker only on a Docker track.
  const programRuns = programs({ whenDockerReady: (operation) => whenReady(trackOf(approved()), operation), log });

  /** Research jobs that ended but whose sources aren't saved yet. */
  const finishing = new Set<string>();

  /** After research saves the roadmap, the pages it read join the agent's own sources (§4.9), at most 10. */
  async function addReads(course: string, reads: { title: string; url: string }[]) {
    const r = core.getRoadmap(ws, course);
    const sources = [...(r.sources ?? [])];
    for (const read of reads) if (!sources.some((s) => s.url === read.url)) sources.push(read);
    if (sources.length === (r.sources ?? []).length) return;
    const { title, goal, track, style, concepts } = r;
    await core.saveRoadmap(ws, course, JSON.stringify({ title, goal, track, style, concepts, sources: sources.slice(0, 10) }), course);
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
      return [...trackers.values()].filter((t) => heard(t.audience)).map((t) => t.tracker.snapshot());
    },
    onRunOutput: (listener) => programRuns.onOutput(listener),
    async agents() {
      await livePath();
      const agents = await d.connect.agents();
      log('agents', Object.fromEntries(agents.map((a) => [a.id, a.untested ? `${a.state}-untested` : a.state])));
      signedInAgain(agents);
      return agents;
    },
    async connect(id) {
      await livePath();
      const agent = await d.connect.connect(id);
      log('connect', { agent: id, state: agent.state, untested: agent.untested || undefined });
      signedInAgain([agent]);
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
    async openWindowsUpdate() {
      await d.docker?.windowsUpdate();
    },
    async restartWindows() {
      log('restart', {});
      await d.docker?.restartWindows();
    },
    async computer() {
      await livePath();
      const computer = await d.computer();
      log('computer', { platform: computer.platform, ...Object.fromEntries(computer.checks.map((c) => [c.id, c.detail ?? c.state])) });
      // Docker works again: every course it stalled starts again (§4.13).
      if (computer.ready) for (const [course, why] of [...stalls]) if (DOCKER_STALLS.includes(why)) resume(course);
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
        // Research counts as running until its sources save and its review ends, so a poll starts no second agent.
        finishing.add(key);
        start(key, 'fg', 'research', briefs.research(course, goal.topic, goal.known, goal.depth, goal.practice), course, () => roadmapOrNull()?.course === course, { onSource })
          .then(async (o) => {
            if (o.ok) {
              // Quitting waits for this save, like any other run (stop()).
              const saving = addReads(course, reads).catch((e: Error) => log('sources-error', errorFields(e)));
              runs.add(saving);
              await saving.finally(() => runs.delete(saving));
              if (!stopping) {
                reviewing.add(course);
                try {
                  const before = JSON.stringify(core.getRoadmap(ws, course));
                  const review = await start(`review:${course}`, 'fg', 'review', briefs.review(), course, (turn) => turn.ok);
                  if (!review.ok) log('review-error', { problem: review.problem });
                  else if (JSON.stringify(core.getRoadmap(ws, course)) === before) log('review-no-change', {});
                } catch (e) {
                  log('review-error', errorFields(e));
                } finally {
                  reviewing.delete(course);
                }
              }
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
      const { course, track } = core.getRoadmap(ws);
      // One of the learner's courses now, on screen (§4.13).
      d.state.update((s) => ({ ...s, approved: course, courses: [...coursesOf(s).filter((c) => c !== course), course] }));
      // Its setup starts fresh, unless another course on its track is installing it.
      if (track && !setups.get(track)?.installing) setups.delete(track);
      resume(course);
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
      const stalled = stalls.get(roadmap.course);
      const failed = stalled === 'lesson' ? failedLessons.get(roadmap.course) : undefined;
      const view: CourseView = { title: nameOf(roadmap), ...courseView(progress, core.listLessons(ws, roadmap.course), state, jobs, undefined, failed) };
      const work = stalledWork.get(roadmap.course);
      if (!stalled) return view;
      // An activity its agent couldn't write can be left for later when that opens another topic (core §7). A review
      // can't: reviews come first whatever was skipped.
      const current = currentConcept(progress);
      const review = progress.next.kind === 'author' && progress.next.review;
      const later = stalled === 'failed' && work === 'author' && !review && current && otherReady(progress, [current]) ? { later: current } : {};
      return { ...view, stalled, ...(work ? { stalledWork: work } : {}), ...later };
    },

    async courses() {
      const s = d.state.read();
      return coursesOf(s).flatMap((id) => {
        const r = roadmapOrNull(id);
        return r ? [{ id, title: nameOf(r), goal: r.goal, track: r.track ? trackName(r.track) : '', current: id === s.approved }] : [];
      });
    },

    async switchCourse(course) {
      if (!coursesOf(d.state.read()).includes(course)) throw new SafeError('No such course.');
      d.state.update((s) => ({ ...s, approved: course }));
      // Opening a course is the learner's step: the work it still needs starts.
      schedule(course);
    },

    async setActivities(on) {
      const course = approved();
      if (!course) throw new SafeError('No course.');
      const { course: _, ...roadmap } = core.getRoadmap(ws, course);
      if (on === (roadmap.style !== 'none')) return;
      if (on && !roadmap.track) {
        await roadmapJob(course, briefs.roadmap('Turn on graded coding activities: choose a track and a style for this course.'), () => () => core.getRoadmap(ws, course).style !== 'none');
      } else if (on) {
        // Back to the style the course had, if its track still offers it.
        const styles = core.listTracks().find((t) => t.track === roadmap.track)?.styles;
        const previous = d.state.read().activityStyles?.[course];
        const style = previous && styles?.includes(previous) ? previous : styles?.[0] ?? previous;
        if (!style) throw new SafeError('Choose a coding style in the roadmap first.');
        await core.saveRoadmap(ws, course, JSON.stringify({ ...roadmap, style }), course);
      } else {
        // Off: its activity jobs stop, and its setup too unless another course with activities shares the track.
        const shared = coursesOf(d.state.read()).some((c) => c !== course && trackOf(c) === roadmap.track && core.getRoadmap(ws, c).style !== 'none');
        await cancel((key) => key.startsWith(`author:${course}:`) || (!shared && key === `setup:${roadmap.track}`));
        d.state.update((s) => ({ ...s, activityStyles: { ...s.activityStyles, [course]: roadmap.style } }));
        await core.saveRoadmap(ws, course, JSON.stringify({ ...roadmap, style: 'none' }), course);
      }
      resume(course);
    },

    async install(digest) {
      const { course, track: ref, style } = core.progress(ws, approved());
      if (!ref || style === 'none') throw new SafeError('This course needs no setup.');
      // This install's own setup: approving the course again replaces it, and this one must not touch that.
      const mine = setupOf(ref);
      const proposal = mine.approved?.digest === digest ? mine.approved : latestProposal(ref, mine);
      if (!proposal || proposal.digest !== digest) throw new SafeError('The setup changed. Look at it again.');
      mine.approved = proposal;
      mine.problem = undefined;
      mine.installs++;
      let tracker: JobTracker | undefined;
      // Tracked and guarded like every container operation: quitting waits for it, its failure handling included, and
      // one still waiting for its turn or for Docker when quitting starts never runs. Builds take turns across courses.
      mine.installing = tracked(queue('builds')(() => {
        // Codemm builds and checks the approved files once its turn comes: the setup's later stages (§4.11).
        const t = (tracker = jobTracker('setup'));
        trackers.set(`install:${ref}`, { tracker: t, audience: { track: ref } });
        t.reach(1);
        tellJob(t.snapshot(), { track: ref });
        return whenReady(ref, () =>
          core.installProposal(ref, digest, (p) => {
            // Counts only: the build's steps or a WASI track's language downloading, then its checks.
            if (p.phase === 'building') t.reach(1, { done: p.done, total: p.total });
            else if (p.phase === 'downloading') t.reach(1, undefined, 'Downloading the language');
            else t.reach(2);
            tellJob(t.snapshot(), { track: ref });
          }),
        );
      })
        .then(() => {
          mine.approved = undefined;
          onTrack(ref, course).forEach(dockerWorked);
        })
        .catch(async (e: Error) => {
          // Quitting isn't a failed setup: nothing is recorded and the proposal stays.
          if (stopping) return;
          // This computer's problems keep the proposal for Try again; nothing is recorded and no agent runs (§6.1).
          const failure = infraOf(e);
          log('setup-failed', { problem: failure?.infra ?? 'gates', cause: failure?.cause });
          if (failure) {
            mine.problem = failure.infra;
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
          if (tracker) tellJob({ ...tracker.snapshot(), ended: true }, { track: ref });
          mine.installing = undefined;
          // Every course on the track moves on.
          onTrack(ref, course).forEach((c) => schedule(c));
        }));
    },

    async retrySetup() {
      const course = approved();
      const roadmap = course ? roadmapOrNull(course) : null;
      if (roadmap?.track) setups.delete(roadmap.track);
      resume(course);
    },

    async retryJobs() {
      resume(approved());
    },

    async lesson(id) {
      return lessonView(core.getLesson(ws, id, approved()));
    },

    async runExample(lessonId, index) {
      try {
        const course = approved();
        return exampleRunView(await whenReady(trackOf(course), () => core.runExample(ws, lessonId, index, course)));
      } catch (e) {
        return asNotCounted(e, log, 'example', 'not-run');
      }
    },
    saveNotes: (id, notes) => core.saveNotes(ws, id, notes, approved()),
    async markRead(id) {
      const course = approved();
      await core.markLessonRead(ws, id, course);
      schedule(course);
    },

    async activity(concept) {
      const course = core.getRoadmap(ws, approved()).course;
      const slug = exerciseFor(concept, course);
      if (!slug) throw new SafeError('This activity isn’t ready yet.');
      openedIn.set(slug, course);
      const exercise = await core.getExercise(ws, slug, course);
      return activityView(exercise, core.readLearnerFiles(ws, slug, course), concept);
    },

    async saveFile(activityId, path, text, digest) {
      try {
        return (await core.writeLearnerFile(ws, activityId, path, text, digest, openedIn.get(activityId) ?? approved())).digest;
      } catch (e) {
        if (kindOf(e) === 'changed') throw new Error(CHANGED);
        throw e;
      }
    },

    async tryIt(activityId, run) {
      try {
        const course = approved();
        const view = tryView(await whenReady(trackOf(course), () => core.testExercise(ws, activityId, course, progressOf(run))));
        dockerWorked(course);
        return view;
      } catch (e) {
        return asNotCounted(e, log, 'try', 'not-counted');
      }
    },

    runProgram: (activityId, run) => programRuns.start(run, (output, options) => core.runInteractive(ws, activityId, approved(), output, options)),
    runExampleLive: (lessonId, index, run) => programRuns.start(run, (output, options) => core.runExampleLive(ws, lessonId, index, approved(), output, options)),
    sendRunInput: (run, text) => programRuns.input(run, text),
    endRunInput: (run) => programRuns.end(run),
    stopRun: (run) => programRuns.stop(run),

    async check(activityId, run) {
      try {
        const course = approved();
        const view = await whenReady(trackOf(course), () => core.checkExercise(ws, activityId, course, progressOf(run)));
        const concepts = core.listExercises(ws, course).find((e) => e.exercise === activityId)?.concepts ?? [];
        const progress = core.progress(ws, course);
        const state = progress.concepts.find((c) => concepts.includes(c.id));
        dockerWorked(course);
        // A graded check can move its course on: the next topic's lesson and activity.
        schedule(course);
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
      // Each question is its own turn, after the one before in its course, so it resumes the session that turn left (§3.2).
      const turn = queue(`tutor:${course}`)(async () => {
        const outcome = await foreground(`tutor:${key}:${++tutorTurnCount}`, 'tutor', briefs.tutor(where, text, files), course, (t) => t.ok, d.state.read().sessions[key]);
        if (outcome.session) d.state.update((s) => ({ ...s, sessions: { ...s.sessions, [key]: outcome.session! } }));
        return outcome;
      });
      const outcome = await turn;
      // Checked against this turn's course, whatever course is approved by now.
      const filter = hidden(course);
      return outcome.text.map((t) => ({ from: 'codemm' as const, text: shown(t, filter) }));
    },

    async skip(concept) {
      const course = approved();
      await core.skip(ws, concept, course);
      // Leaving an activity its agent couldn't write for later ends that stall: the next topic's lesson and activity
      // start (core §7). Any other stall (Docker, the network, a plan limit) still waits for Try again.
      if (course && stalls.get(course) === 'failed' && stalledWork.get(course) === 'author') resume(course);
      else schedule(course);
    },

    async easier(concept) {
      const course = core.getRoadmap(ws, approved()).course;
      const title = core.getRoadmap(ws, course).concepts.find((c) => c.id === concept)?.title ?? concept;
      await roadmapJob(course, briefs.easier(concept, title), (before) => () => JSON.stringify(core.getRoadmap(ws, course)) !== before);
      schedule(course);
    },

    async rebuild(ref) {
      // A job of its own (§4.11), heard whatever course is on screen, since Tracks isn't a course's. Core reports no
      // steps, so it has the one stage; it starts when its turn comes and ends with the rebuild, failed or not.
      let tracker: JobTracker | undefined;
      // Tracked and guarded like the install, so quitting waits for it; builds take turns across courses (§4.13).
      await tracked(
        queue('builds')(() => {
          const t = (tracker = jobTracker('rebuild', { track: trackName(ref) }));
          t.reach(0);
          trackers.set(`rebuild:${ref}`, { tracker: t, audience: {} });
          tellJob(t.snapshot(), {});
          return whenReady(ref, () => core.rebuildTrack(ref));
        }),
      )
        .catch((e: unknown) => Promise.reject(rebuildFailure(e)))
        .finally(() => {
          trackers.delete(`rebuild:${ref}`);
          if (tracker) tellJob({ ...tracker.snapshot(), ended: true }, {});
        });
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
