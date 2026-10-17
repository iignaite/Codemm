// The CodemmApi over the real core and the learner's own agent (DESIGN §2–§6).
// Main calls core `app` functions in-process; agent jobs run through the
// bridge; everything returned goes through views.ts.
import {
  AGENT_FAILED,
  CHANGED,
  PLAN_LIMIT,
  SIGNED_OUT,
  type CodemmApi,
  type Computer,
  type Concept,
  type CourseView,
  type Proposal,
  type Roadmap,
} from '../shared/api';
import models from '../shared/models.json';
import type { McpServer } from './agent/agents';
import { briefs } from './agent/briefs';
import { runJob as realRunJob, type Job, type JobKind, type JobOutcome, type JobProblem } from './agent/jobs';
import type { connector } from './connect';
import type { CoreApp, CoreProgress, CoreRoadmap } from './core/types';
import { courseView, type Setup } from './courseView';
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
  /** Aborted when the app quits: running agent jobs stop with their process groups. */
  signal?: AbortSignal;
}

/** Setup proposals per setup before the learner gets Stop or Try again (§3.2). */
const PROPOSAL_BOUND = 3;
const OFFLINE = /could not resolve host|network is unreachable|temporary failure in name resolution|offline/i;
const DISK = /no space left on device|not enough disk space/i;
const trackName = (ref: string) => ref.split('@')[0];
const problemError = (problem: JobProblem) => new Error({ 'plan-limit': PLAN_LIMIT, 'signed-out': SIGNED_OUT, failed: AGENT_FAILED }[problem]);

/** An infrastructure failure the learner can fix on this computer: the check isn't counted (§5, §6.1). */
function notCounted(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/No container runtime found/i.test(message)) return "Docker isn't installed on this computer.";
  if (/Windows containers/i.test(message)) return 'Docker Desktop is set to Windows containers.';
  if (/runtime isn't running|Cannot connect to the Docker daemon/i.test(message)) return "Docker isn't running.";
  if (/image for .* is missing or changed/i.test(message)) return 'This environment needs a rebuild. Rebuild it under Tracks.';
  return null;
}

export function createLive(d: LiveDeps): CodemmApi {
  const { core, ws } = d;
  const runJob = d.runJob ?? realRunJob;
  const running = new Map<string, Promise<JobOutcome>>();
  const lanes = { fg: Promise.resolve() as Promise<unknown>, bg: Promise.resolve() as Promise<unknown> };
  const outcomes = new Map<string, JobOutcome>();
  let stalled: CourseView['stalled'];
  let install: { run?: Promise<void>; problem?: 'offline' | 'disk'; gateFailures: number; lastGateProblem?: string } = { gateFailures: 0 };

  const roadmapOrNull = (): CoreRoadmap | null => {
    try {
      return core.getRoadmap(ws);
    } catch {
      return null;
    }
  };
  const installed = (ref: string) => core.listTracks().some((t) => `${t.id}@${t.version}` === ref);
  const roadmapView = (r: CoreRoadmap): Roadmap => ({ goal: r.goal, track: trackName(r.track), installed: installed(r.track), concepts: r.concepts.map((c) => ({ id: c.id, title: c.title, requires: [...c.requires] })) });

  /** Saves the learner's edits through core's roadmap rules (§4.2). JSON is YAML. */
  async function saveConcepts(concepts: Concept[]) {
    const current = core.getRoadmap(ws);
    const yaml = JSON.stringify({ goal: current.goal, track: current.track, style: current.style, concepts });
    await core.saveRoadmap(ws, current.course, yaml, current.course);
  }

  /** Runs one agent job in a lane: one foreground job and one background queue at a time (§3.2). */
  function start(key: string, lane: 'fg' | 'bg', kind: JobKind, brief: string, course: string | undefined, done: Job['done'], resume?: string): Promise<JobOutcome> {
    const existing = running.get(key);
    if (existing) return existing;
    const job = (async () => {
      const { id, exe } = await d.connect.chosen();
      return runJob({
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
        signal: d.signal,
        done,
        signedIn: () => d.connect.recheck(id, exe),
      });
    })();
    const queued = lanes[lane].then(() => job, () => job);
    lanes[lane] = queued.catch(() => undefined);
    const tracked = queued.finally(() => running.delete(key));
    running.set(key, tracked);
    return tracked;
  }

  /** Background work: a failure stalls it until the learner retries, instead of relaunching on every look. */
  function background(key: string, kind: JobKind, brief: string, course: string, done: Job['done']) {
    if (stalled || running.has(key)) return;
    start(key, 'bg', kind, brief, course, done)
      .then((o) => {
        if (!o.ok) stalled = o.problem ?? 'failed';
      })
      .catch((e: Error) => {
        stalled = e.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed';
      });
  }

  function proposalView(ref: string): Proposal | undefined {
    const latest = core.listProposals().filter((p) => p.track === ref).sort((a, b) => b.created.localeCompare(a.created))[0];
    if (!latest) return undefined;
    return { digest: latest.digest, retry: install.gateFailures > 0, files: Object.entries(latest.files).map(([path, text]) => ({ path, text })) };
  }

  /** One consent before setup (§4.1): propose, wait for the learner, build exactly what they saw. */
  function setupState(progress: CoreProgress): Setup {
    const ref = progress.track;
    if (installed(ref)) return { state: 'ready' };
    if (install.run) return { state: 'installing' };
    if (install.problem) return { state: 'failed', problem: install.problem };
    if (install.gateFailures >= PROPOSAL_BOUND) return { state: 'failed', problem: 'gates' };
    const proposal = proposalView(ref);
    if (proposal) return { state: 'consent', proposal };
    const before = new Set(core.listProposals().map((p) => p.digest));
    background('setup', 'setup', briefs.setup(ref, install.lastGateProblem), progress.course, () => core.listProposals().some((p) => p.track === ref && !before.has(p.digest)));
    return { state: 'proposing' };
  }

  /** Starts the lesson and activity jobs the next step needs (§3.2, §4.3). */
  function work(progress: CoreProgress) {
    const next = progress.next;
    if (next.kind !== 'practice' && next.kind !== 'author') return;
    const concept = progress.concepts.find((c) => c.id === next.concept);
    if (!concept) return;
    if (next.lesson === null) {
      const before = core.listLessons(ws).filter((l) => l.concept === concept.id).length;
      background(`lesson:${concept.id}`, 'lesson', briefs.lesson(concept.id, concept.title), progress.course, () => core.listLessons(ws).filter((l) => l.concept === concept.id).length > before);
    }
    if (next.kind === 'author') {
      background(`author:${concept.id}`, 'author', briefs.author(), progress.course, () => {
        const now = core.progress(ws).next;
        return now.kind === 'practice' && now.concept === concept.id;
      });
    }
  }

  function currentHidden(): string[] {
    const { course, current } = core.readWorkspace(ws);
    if (!course || !current) return [];
    try {
      const { record, files } = core.readExercise(course, current);
      return hiddenLines(files, record.expected);
    } catch {
      return [];
    }
  }

  async function foreground(key: string, kind: JobKind, brief: string, course: string | undefined, done: Job['done'], resume?: string) {
    const outcome = await start(key, 'fg', kind, brief, course, done, resume);
    if (!outcome.ok && outcome.problem) throw problemError(outcome.problem);
    return outcome;
  }

  return {
    agents: () => d.connect.agents(),
    connect: (id) => d.connect.connect(id),
    computer: () => d.computer(),

    async tracks() {
      return core.listTracks().map((t) => ({ ref: `${t.id}@${t.version}`, name: t.id }));
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
        const before = roadmapOrNull()?.course;
        start(key, 'fg', 'research', briefs.research(goal.topic, goal.known), undefined, () => {
          const after = roadmapOrNull();
          return Boolean(after && after.course !== before);
        })
          .then((o) => outcomes.set(key, o))
          .catch((e: Error) => outcomes.set(key, { ok: false, problem: e.message.includes(SIGNED_OUT) ? 'signed-out' : 'failed', text: [] }));
      }
      return { state: 'running' };
    },

    async reviseRoadmap(concepts, request) {
      await saveConcepts(concepts);
      const before = JSON.stringify(core.getRoadmap(ws));
      const course = core.getRoadmap(ws).course;
      const changed = () => JSON.stringify(core.getRoadmap(ws)) !== before;
      const outcome = await foreground('roadmap', 'roadmap', briefs.roadmap(request), course, (turn) => turn.ok || changed());
      return { roadmap: roadmapView(core.getRoadmap(ws)), changed: changed(), text: outcome.text.join('\n\n') };
    },

    async approve(concepts) {
      await saveConcepts(concepts);
      stalled = undefined;
      install = { gateFailures: 0 };
    },

    async course() {
      if (!roadmapOrNull()) return null;
      const progress = core.progress(ws);
      const setup = progress.next.kind === 'setup' ? setupState(progress) : { state: 'ready' as const };
      if (setup.state === 'ready') work(progress);
      const view = courseView(progress, core.listLessons(ws), setup, new Set(running.keys()));
      return stalled ? { ...view, stalled } : view;
    },

    async install(digest) {
      const ref = core.progress(ws).track;
      if (!core.listProposals().some((p) => p.track === ref && p.digest === digest)) throw new Error('The setup changed. Look at it again.');
      install.problem = undefined;
      install.run = core
        .installProposal(ref, digest)
        .then(() => undefined)
        .catch((e: Error) => {
          // Offline and low disk are this computer's problems: nothing is recorded and no agent runs (§6.1).
          if (DISK.test(e.message)) install.problem = 'disk';
          else if (OFFLINE.test(e.message)) install.problem = 'offline';
          else {
            install.gateFailures++;
            install.lastGateProblem = e.message;
            void core.dropProposal(ref).catch(() => undefined);
          }
        })
        .finally(() => (install.run = undefined));
    },

    async retrySetup() {
      install = { gateFailures: 0 };
      stalled = undefined;
    },

    async retryJobs() {
      stalled = undefined;
    },

    async lesson(id) {
      return core.getLesson(ws, id);
    },
    saveNotes: (id, notes) => core.saveNotes(ws, id, notes),
    markRead: (id) => core.markLessonRead(ws, id),

    async activity(concept) {
      const next = core.progress(ws).next;
      if (next.kind !== 'practice' || next.concept !== concept) throw new Error('This activity isn’t open yet.');
      const exercise = await core.getExercise(ws, next.exercise);
      return activityView(exercise, core.readLearnerFiles(ws, next.exercise), concept);
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
        return tryView(await core.testExercise(ws, activityId));
      } catch (e) {
        const reason = notCounted(e);
        if (reason) return { kind: 'not-counted', reason };
        throw e;
      }
    },

    async check(activityId) {
      const next = core.progress(ws).next;
      const concept = next.kind === 'practice' && next.exercise === activityId ? next.concept : undefined;
      try {
        const view = await core.checkExercise(ws, activityId);
        const state = core.progress(ws).concepts.find((c) => c.id === concept);
        return checkView(view, { stuck: state?.stuck ?? false, mastered: state?.mastered ?? false });
      } catch (e) {
        const reason = notCounted(e);
        if (reason) return { kind: 'not-counted', reason };
        throw e;
      }
    },

    async ask(place, text) {
      const { id } = await d.connect.chosen();
      const course = core.getRoadmap(ws).course;
      const key = `${course}|${id}`;
      const where = 'lessonId' in place ? `the lesson "${place.lessonId}" (get_lesson)` : `the activity "${place.activityId}" (get_exercise)`;
      const outcome = await foreground(`tutor:${key}`, 'tutor', briefs.tutor(where, text), course, (turn) => turn.ok, d.state.read().sessions[key]);
      if (outcome.session) d.state.update((s) => ({ ...s, sessions: { ...s.sessions, [key]: outcome.session! } }));
      const hidden = currentHidden();
      return outcome.text.map((t) => ({ from: 'codemm' as const, text: filterReply(t, hidden) }));
    },

    async skip(concept) {
      await core.skip(ws, concept);
    },

    async easier(concept) {
      const roadmap = core.getRoadmap(ws);
      const title = roadmap.concepts.find((c) => c.id === concept)?.title ?? concept;
      const before = JSON.stringify(roadmap);
      await foreground('roadmap', 'roadmap', briefs.easier(concept, title), roadmap.course, () => JSON.stringify(core.getRoadmap(ws)) !== before);
    },

    async rebuild(ref) {
      await core.rebuildTrack(ref);
    },
  };
}
