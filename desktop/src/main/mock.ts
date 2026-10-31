// An in-memory CodemmApi, for tests and for clicking through screens in
// development (CODEMM_MOCK). Like the core, it never holds a solution or a
// hidden test: it grades by whether the learner replaced the starter's
// placeholder, and reports hidden results as statuses only.
import { type CheckProgress, type JobKind, type JobProgress, type JobStep, type RunOutput, type UpdateStatus, type RunResult,
  AGENT_FAILED,
  CHANGED,
  NO_AGENT,
  OFFLINE,
  PLAN_LIMIT,
  REBUILD,
  SIGNED_OUT,
  type Activity,
  type Agent,
  type AgentId,
  type AgentInstall,
  type ComputerCheck,
  type CheckResult,
  type CodemmApi,
  type Concept,
  type CourseView,
  type Lesson,
  type Platform,
  type Roadmap,
  type SetupProblem,
  type TestView,
  type Track,
  type DockerInstall,
} from '../shared/api';
import { modelChoices, modelFor } from '../shared/models';
import { AGENT_INFO } from './connect';
import { addTopic } from '../shared/roadmap';
import { shownTopic } from '../shared/topic';

/** Windows' WSL states are the running row's, as Docker Desktop's engine can't start without WSL. */
type Wsl = 'wsl-missing' | 'wsl-old' | 'virtualization' | 'wsl-restart';
type Docker = 'missing' | 'stopped' | 'starting' | 'windows-containers' | Wsl | 'no-sandbox' | 'sandbox-checking' | 'sandbox-offline' | 'sandbox-folder' | 'ready';

export interface MockOptions {
  /** Read on every call, so a test can change it while the app runs. */
  docker?: Docker;
  platform?: Platform;
  /** Agents that aren't installed, or whose sign-in check fails. Read on every look, as main's lookup is. */
  agents?: Partial<Record<AgentId, 'missing' | 'signed-out'>>;
  /** The track's image is missing or changed: checks aren't counted until it's rebuilt. */
  imageMissing?: boolean;
  /** Read on every call: agent jobs fail with this until it's cleared. */
  agentProblem?: 'signed-out' | 'plan-limit' | 'offline' | 'failed';
  /** wasmtime runs here, so io practice runs without Docker when Docker isn't installed (core §4.5). */
  wasi?: boolean;
  /** Docker installs but doesn't start: its start window ends with Docker stopped. */
  dockerWontStart?: boolean;
  /** Installing an agent stops with this problem. */
  agentInstallProblem?: NonNullable<AgentInstall['problem']>;
  untested?: boolean;
  /** The agent connected before: a relaunch shows it connected. */
  connected?: AgentId;
  setupProblem?: SetupProblem;
  /** Read on every call: background work stopped with this until the learner tries again or connects again. */
  stalled?: CourseView['stalled'];
  stalledWork?: CourseView['stalledWork'];
  /** With a stall: the topic its banner offers to leave for later (CourseView.later). */
  laterTopic?: string;
  /** 'io': activities read input and print, so they have Run. */
  style?: 'io';
  /** Run's time limit; 120 s by default. */
  runLimitMs?: number;
  /** What the update check says, to see the update notice. */
  update?: UpdateStatus;
  /**
   * Agent jobs take this many course reads per stage (and research per step), and calls such as a roadmap change
   * take this many half seconds, so each staged progress state can be seen (§4.11). Without it, jobs finish at once.
   */
  slow?: number;
  /** Every job has been quiet for over 90 seconds, so its "still working" line shows. */
  quiet?: boolean;
  /** A topic is mastered by a pass on its `passes`th activity; each pass before that opens its next activity, as core's mastery takes several (core §7). 1 by default. */
  passes?: number;
  /** Changes the options after the first approval, check or look at the agents, to act out a mid-session change. */
  later?: { after: 'approve' | 'check' | 'look'; set: Partial<MockOptions> };
}

/** Named environment states (D13), for tests and for `CODEMM_MOCK` in development. */
export const SCENARIOS: Record<string, MockOptions> = {
  'no-docker': { docker: 'missing' },
  'no-docker-wasi': { docker: 'missing', wasi: true },
  'docker-stopped': { docker: 'stopped' },
  'docker-starting': { docker: 'starting' },
  'sandbox-checking': { docker: 'sandbox-checking' },
  'windows-containers': { docker: 'windows-containers', platform: 'windows' },
  'wsl-missing': { docker: 'wsl-missing', platform: 'windows' },
  'virtualization-off': { docker: 'virtualization', platform: 'windows' },
  'docker-stops': { later: { after: 'check', set: { docker: 'stopped' } } },
  'docker-stops-jobs': { later: { after: 'approve', set: { docker: 'stopped', stalled: 'docker' } } },
  'docker-wont-start': { docker: 'missing', dockerWontStart: true },
  'offline-setup': { setupProblem: 'offline' },
  'low-disk': { setupProblem: 'disk' },
  'setup-gates': { setupProblem: 'gates' },
  'no-agent': { agents: { claude: 'missing', codex: 'missing', cursor: 'missing' } },
  'nothing-installed': { docker: 'missing', agents: { claude: 'missing', codex: 'missing', cursor: 'missing' } },
  'nothing-installed-offline': { docker: 'missing', agents: { claude: 'missing', codex: 'missing', cursor: 'missing' }, agentInstallProblem: 'offline' },
  'agent-install-offline': { agents: { claude: 'missing', codex: 'missing', cursor: 'missing' }, agentInstallProblem: 'offline' },
  'one-agent': { agents: { codex: 'missing', cursor: 'missing' } },
  // Installed in a terminal while Codemm is open: Welcome and Connect see it within seconds.
  'agent-found-later': { agents: { claude: 'missing', codex: 'missing', cursor: 'missing' }, later: { after: 'look', set: { agents: { codex: 'missing', cursor: 'missing' } } } },
  relaunch: { connected: 'claude' },
  'signed-out': { agents: { claude: 'signed-out', codex: 'signed-out', cursor: 'missing' } },
  'sign-in-expires': { later: { after: 'approve', set: { agentProblem: 'signed-out' } } },
  'plan-limit': { later: { after: 'approve', set: { agentProblem: 'plan-limit' } } },
  'untested-version': { untested: true },
  'io-track': { style: 'io' },
  'io-docker-stopped': { style: 'io', docker: 'stopped' },
  'image-missing': { imageMissing: true },
  'run-time-up': { style: 'io', runLimitMs: 3000 },
  'update-available': { update: { kind: 'available', version: '1.0.1', url: 'https://github.com/iignaite/Codemm/releases/tag/v1.0.1' } },
  'update-ready': { update: { kind: 'ready', version: '1.0.1' } },
  'slow-jobs': { slow: 4 },
  'quiet-jobs': { slow: 4, quiet: true },
};

const step = (label: string): JobStep => ({ kind: 'step', label });
/** What each mock job reports, beat by beat, as a real one would (§4.11). `codemm`: Codemm's own tool is running. */
type Beat = { stage: number; step?: JobStep; codemm?: true; retry?: JobProgress['retry']; part?: JobProgress['part'] };
const CHECKING = step('Codemm is checking the exercise');
const gate = (n: number, label: string, retry?: JobProgress['retry']): Beat => ({ stage: 2, step: step(label), codemm: true, part: { done: n, total: 3 }, ...(retry ? { retry } : {}) });
const BEATS: Record<Exclude<JobKind, 'research' | 'rebuild'> | 'install', Beat[]> = {
  review: [{ stage: 0 }, { stage: 1, step: step('Reading the roadmap') }, { stage: 2, step: step('Saving the roadmap'), codemm: true }],
  roadmap: [{ stage: 0 }, { stage: 1, step: step('Reading the roadmap') }, { stage: 2, step: step('Saving the roadmap'), codemm: true }],
  setup: [{ stage: 0 }, { stage: 0, step: step('Checking the installed tracks') }, { stage: 0, step: step('Proposing the setup'), codemm: true }],
  install: [1, 2, 3, 4, 5].map((done): Beat => ({ stage: 1, codemm: true, part: { done, total: 5 } })).concat([{ stage: 2, codemm: true }]),
  lesson: [{ stage: 0 }, { stage: 1, step: step('Reading the roadmap') }, { stage: 2, step: step('Saving the lesson'), codemm: true }],
  author: [
    { stage: 0 },
    { stage: 1, step: step('Writing the exercise') },
    { stage: 2, step: CHECKING, codemm: true },
    gate(1, 'Codemm is checking that the exercise can be solved'),
    gate(2, "Codemm is checking that the exercise isn't solved yet"),
    { stage: 1, step: step('Writing the exercise'), retry: { attempt: 2, of: 3 } },
    { stage: 2, step: CHECKING, codemm: true, retry: { attempt: 2, of: 3 } },
    gate(3, 'Codemm is checking that the tests catch mistakes', { attempt: 2, of: 3 }),
  ],
  tutor: [{ stage: 0 }, { stage: 0, step: step('Reading the activity') }],
};

export function scenario(name: string | undefined): MockOptions {
  if (!name) return {};
  if (!Object.hasOwn(SCENARIOS, name)) throw new Error(`Unknown mock scenario: ${name}`);
  return structuredClone(SCENARIOS[name]);
}

const DOCKER_DOWN: Record<Exclude<Docker, 'ready'>, string> = {
  missing: "Docker isn't installed on this computer.",
  stopped: "Docker isn't running.",
  starting: 'Docker is still starting.',
  'windows-containers': 'Docker Desktop is set to Windows containers.',
  'wsl-missing': "Docker isn't running.",
  'wsl-old': "Docker isn't running.",
  virtualization: "Docker isn't running.",
  'wsl-restart': "Docker isn't running.",
  'no-sandbox': "Codemm couldn't confirm the sandbox.",
  'sandbox-checking': "Codemm couldn't confirm the sandbox.",
  'sandbox-offline': "Codemm couldn't confirm the sandbox.",
  'sandbox-folder': "Codemm couldn't confirm the sandbox.",
};

/** The sandbox self-test's own words for a known cause, as core gives them (core §4.3). */
const SANDBOX_REASON: Partial<Record<Docker, NonNullable<ComputerCheck['reason']>>> = {
  'sandbox-offline': {
    kind: 'offline',
    text: "Docker couldn't reach the network to download the test image (dial tcp: lookup registry-1.docker.io: no such host). Connect to the internet, check any VPN, proxy or firewall, then try again.",
  },
  'sandbox-folder': {
    kind: 'docker',
    text: "Docker couldn't start a test container with Codemm's folder mounted (mounts denied). Codemm keeps what a check mounts in ~/.codemm/runs. If the engine says it can't see that folder, share it with the engine (Colima and Rancher Desktop share only your home folder by default), then try again.",
  },
};

/** The connect screen's agents, as the connector describes them; Codemm installs each of them. */
const AGENTS: Omit<Agent, 'state' | 'untested'>[] = (Object.keys(AGENT_INFO) as AgentId[]).map((id) => ({
  id, ...AGENT_INFO[id], canInstall: true, models: modelChoices(id), model: modelFor(id),
}));

const TOPICS: [string, string[]][] = [
  ['JavaScript basics', []],
  ['JSX', ['javascript-basics']],
  ['Components', ['jsx']],
  ['Props', ['components']],
  ['State', ['components']],
  ['Events', ['state']],
  ['Lists and keys', []],
  ['Forms', []],
];

const PLACEHOLDER = '/* your code */';
const STARTER = `import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);

  function handleClick() {
    setCount(${PLACEHOLDER});
  }

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={handleClick}>Add one</button>
    </div>
  );
}
`;

const IO_STARTER = `name = input("What's your name? ")\nprint(${PLACEHOLDER})\n`;
const APP = "import Counter from './Counter';\n\nexport default function App() {\n  return <Counter />;\n}\n";

const PROPOSAL_FILES = [
  { path: 'Dockerfile', text: 'FROM node:22-alpine\nWORKDIR /work\nRUN npm install --global vitest@3\n' },
  { path: 'track.yaml', text: 'id: react\nversion: 1\nstyles: [unit]\n' },
];

/** A stable 64-hex stand-in for core's SHA-256 digests. */
function digestOf(text: string): string {
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'mac';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function createMock(options: MockOptions = {}): CodemmApi {
  const agents = AGENTS.map((a) => ({ ...a, state: (options.agents?.[a.id] === 'missing' ? 'missing' : options.connected === a.id ? 'connected' : 'not-connected') as Agent['state'] }));
  const tracks: Track[] = [];
  // The course on screen: its lessons, activities, roadmap and view. Switching swaps them for another course's (§4.13).
  let lessons = new Map<string, Lesson>();
  let activities = new Map<string, { activity: Activity; fails: number }>();
  let research: { topic: string; calls: number; job: string; review: string; started: number } | null = null;
  /** The roadmap research wrote or the learner edited; a draft until approved. */
  let roadmap: Roadmap | null = null;
  let drafting = false;
  /** The approved course's roadmap: it stays the course while a new roadmap is a draft (§4.2). */
  let approved: Roadmap | null = null;
  let course: CourseView | null = null;
  let checks = 0;
  /** Concepts skipped since their last check (§4.4). */
  let deferred = new Set<string>();
  /** Every approved course, by id, and the one on screen. */
  const kept = new Map<string, { course: CourseView; approved: Roadmap; lessons: typeof lessons; activities: typeof activities; deferred: typeof deferred }>();
  let current = '';

  // Installing or opening Docker moves the mock's Docker along, one step per check (§6.1).
  let dockerNow: Docker | undefined;
  let install: DockerInstall | undefined;
  const WSL_SETUP = new Set<Docker>(['wsl-missing', 'wsl-old']);
  const INSTALL_STEPS: DockerInstall[] = [{ phase: 'downloading', progress: 0.6 }, { phase: 'checking' }, { phase: 'installing' }, { phase: 'starting' }];
  const docker = () => dockerNow ?? options.docker ?? 'ready';
  const notCounted = () => ({ kind: 'not-counted' as const, reason: options.imageMissing ? REBUILD : DOCKER_DOWN[docker() as Exclude<Docker, 'ready'>] });
  const counts = () => docker() === 'ready' && !options.imageMissing;
  const find = <T>(map: Map<string, T>, key: string): T => {
    const value = map.get(key);
    if (!value) throw new Error(`Unknown id: ${key}`);
    return value;
  };
  const topicOf = (concept: string) => {
    const topic = course?.topics.find((t) => t.id === concept);
    if (!topic) throw new Error(`Unknown topic: ${concept}`);
    return topic;
  };

  /** Agent jobs fail while the agent can't run. */
  function agentJob() {
    if (!agents.some((a) => a.state === 'connected')) throw new Error(NO_AGENT);
    const problem = options.agentProblem;
    if (problem) throw new Error({ 'signed-out': SIGNED_OUT, 'plan-limit': PLAN_LIMIT, offline: OFFLINE, failed: AGENT_FAILED }[problem]);
  }

  function happen(after: 'approve' | 'check' | 'look') {
    if (options.later?.after !== after) return;
    Object.assign(options, options.later.set);
    delete options.later;
  }

  function addConcept(concept: Concept) {
    const own: Omit<Lesson, 'examples'>[] = [
      { id: `${concept.id}-1`, concept: concept.id, title: `What ${concept.title.toLowerCase()} is`, markdown: `# ${concept.title}\n\n${concept.title} in one idea, before any code.`, notes: '' },
      {
        id: `${concept.id}-2`,
        concept: concept.id,
        title: 'useState',
        markdown: '# useState\n\nA value React remembers. Set it, and the screen updates.\n\n```\nconst [count, setCount] = useState(0);\n```\n\nAfter two clicks on **Add one**, the counter shows `Count: 2`.',
        notes: '',
      },
    ];
    own.forEach((l) => lessons.set(l.id, { ...l, examples: [] }));
    // An io course's first lesson has an example Run takes typed input for.
    if (options.style === 'io') {
      const first = lessons.get(own[0].id)!;
      first.markdown += '\n\nTry it: type a name.\n\n```example\n1\n```';
      first.examples = [{ files: [{ path: 'main.py', text: 'name = input("What\'s your name? ")\nprint(f"Hello, {name}!")\n' }] }];
      first.style = 'io';
    }
    const activity = exercise(concept.id, 1);
    activities.set(activity.id, { activity, fails: 0 });
    return { id: concept.id, title: concept.title, state: 'later' as const, mastery: 0, stuck: false, lessons: own.map((l) => ({ id: l.id, title: l.title, state: 'writing' as const })), activity: 'writing' as const };
  }

  /** A concept's `n`th activity, from its starter files. */
  function exercise(concept: string, n: number): Activity {
    const activity: Activity = options.style === 'io' ? {
      id: `${concept}-easy-1`,
      concept,
      title: 'Greet by name',
      statement: 'Read a name, then print `Hello, <name>!`.',
      visibleTests: [
        { name: '01', input: 'Ada\n', expected: 'Hello, Ada!\n' },
        { name: '02', input: 'Grace\n', expected: 'Hello, Grace!\n' },
      ],
      files: [{ path: 'main.py', text: IO_STARTER, digest: digestOf(IO_STARTER) }],
      run: 'python3 main.py',
    } : {
      id: `${concept}-easy-1`,
      concept,
      title: 'Click Counter',
      statement: 'Make the count go up by one on each click.\n\nAfter three clicks it shows `Count: 3`.',
      visibleTests: [
        { name: 'Shows Count: 0', expected: 'Count: 0' },
        { name: 'Adds one per click', expected: 'Count: 1' },
      ],
      files: [
        { path: 'Counter.jsx', text: STARTER, digest: digestOf(STARTER) },
        { path: 'App.jsx', text: APP, digest: digestOf(APP) },
      ],
    };
    return n === 1 ? activity : { ...activity, id: `${concept}-easy-${n}`, title: `${activity.title} ${n}` };
  }

  function start(concept: string) {
    const topic = topicOf(concept);
    topic.state = 'now';
    topic.lessons.forEach((l, i) => (l.state = l.state === 'read' ? 'read' : i === 0 ? 'ready' : 'writing'));
  }

  function unlock(concept: string) {
    const topic = topicOf(concept);
    // An activity still being written opens once its author job ends (tick).
    if (!course?.activities || topic.activity === 'passed' || topic.activity === 'writing' || course?.setup !== 'ready') return;
    topic.activity = topic.lessons.every((l) => l.state === 'read') ? 'open' : 'locked';
  }

  /**
   * The next topic: not mastered, every prerequisite mastered or left for later (core §7), and a deferred one only if
   * nothing else is ready (§4.4).
   */
  function advance() {
    const c = course!;
    const requires = (id: string) => approved!.concepts.find((x) => x.id === id)?.requires ?? [];
    const complete = (t: CourseView['topics'][number]) => c.activities ? t.mastery === 1 : t.lessons.length > 0 && t.lessons.every((l) => l.state === 'read');
    c.topics.forEach((t) => { t.state = complete(t) ? c.activities ? 'mastered' : 'covered' : 'later'; });
    const ready = c.topics.filter((t) => !complete(t) && requires(t.id).every((r) => complete(topicOf(r)) || deferred.has(r)));
    c.done = c.topics.every(complete);
    const next = ready.find((t) => !deferred.has(t.id)) ?? ready[0];
    if (next) start(next.id);
  }

  // Background jobs advance one step each time the UI reads the course.
  function tick(c: CourseView) {
    if (c.setup === 'proposing') {
      if (!busy(`${current}:setup`, 'setup')) {
        c.setup = 'consent';
        c.proposal = { digest: digestOf(PROPOSAL_FILES.map((f) => f.text).join('')), retry: Boolean(c.proposal), ...(c.proposal ? { why: "The last try didn't build." } : {}), files: PROPOSAL_FILES };
      }
    } else if (c.setup === 'installing' && !busy(`${current}:install`, 'install')) {
      if (options.setupProblem) {
        c.setup = 'failed';
        c.setupProblem = options.setupProblem;
      } else {
        c.setup = 'ready';
        delete c.proposal;
        if (!tracks.some((t) => t.name === c.track)) tracks.push({ ref: `${slugOf(c.track)}@1`, name: c.track });
      }
    }
    const now = c.topics.find((t) => t.state === 'now');
    if (!now) return;
    const writing = now.lessons.find((l) => l.state === 'writing');
    if (writing && !busy(`${current}:lesson:${now.id}`, 'lesson', now.id)) writing.state = 'ready';
    if (c.activities && now.activity === 'writing' && c.setup === 'ready' && !busy(`${current}:author:${now.id}`, 'author', now.id)) now.activity = 'locked';
    unlock(now.id);
  }

  // Progress as a real check reports it: each test, as counts only.
  const progressListeners = new Set<(p: CheckProgress) => void>();
  const jobListeners = new Set<(p: JobProgress) => void>();
  /** The mock's running jobs, as their latest progress (§4.11). */
  const jobs = new Map<string, JobProgress>();
  const tellJob = (p: JobProgress) => {
    if (p.ended) jobs.delete(p.job);
    else jobs.set(p.job, p);
    jobListeners.forEach((l) => l(p));
  };
  const quietMs = () => (options.quiet ? 95_000 : 0);
  let jobCount = 0;
  /** A mock job's report after `beats`, its steps newest first. */
  function report(job: string, kind: JobKind, beats: Beat[], started: number, concept?: string): JobProgress {
    const beat = beats.at(-1)!;
    const steps = beats.flatMap((b) => (b.step ? [b.step] : [])).reverse().slice(0, 8);
    return {
      job, kind, ...(concept ? { concept } : {}), stage: beat.stage, steps, count: steps.length, ...(beat.retry ? { retry: beat.retry } : {}), ...(beat.part ? { part: beat.part } : {}),
      thinking: !beat.codemm, elapsedMs: Date.now() - started + quietMs(), idleMs: quietMs(),
    };
  }
  /** Background jobs, by key: each moves one beat per `slow` course reads. */
  const playing = new Map<string, { job: string; kind: JobKind; script: Beat[]; beat: number; reads: number; started: number; concept?: string }>();
  /** True while the job keyed `key` still plays; false once it has ended, and its work can land. */
  function busy(key: string, kind: keyof typeof BEATS, concept?: string): boolean {
    let p = playing.get(key);
    const jobKind: JobKind = kind === 'install' ? 'setup' : kind;
    if (!p) {
      p = { job: `mock-${++jobCount}`, kind: jobKind, script: BEATS[kind], beat: 0, reads: 0, started: Date.now(), concept };
      playing.set(key, p);
      tellJob(report(p.job, jobKind, p.script.slice(0, 1), p.started, concept));
    }
    if (options.slow && ++p.reads < options.slow) return true;
    p.reads = 0;
    // Without `slow`, the whole job plays now.
    while (++p.beat < p.script.length) {
      tellJob(report(p.job, jobKind, p.script.slice(0, p.beat + 1), p.started, concept));
      if (options.slow) return true;
    }
    playing.delete(key);
    tellJob({ ...report(p.job, jobKind, p.script, p.started, concept), ended: true });
    return false;
  }
  /** A job a call waits for (a roadmap change, a tutor turn): it plays through, half a second per beat when slow. */
  async function playThrough(kind: 'roadmap' | 'tutor') {
    const job = `mock-${++jobCount}`;
    const started = Date.now();
    const script = BEATS[kind];
    for (let i = 1; i <= script.length; i++) {
      tellJob(report(job, kind, script.slice(0, i), started));
      if (options.slow) await new Promise((r) => setTimeout(r, options.slow! * 500));
    }
    tellJob({ ...report(job, kind, script, started), ended: true });
  }
  const runListeners = new Set<(o: RunOutput) => void>();
  const tell = (o: RunOutput) => runListeners.forEach((l) => l(o));
  /** Run's programs: each asks for a name and greets it. */
  const programs = new Map<string, { input(text: string): void; stop(): void }>();
  /** One Run, an activity's or a lesson example's: asks for a name, greets it, then ends; or stops, or runs out of time. */
  function greet(run: string): Promise<RunResult> {
    if (docker() !== 'ready') return Promise.resolve({ kind: 'not-run', reason: DOCKER_DOWN[docker() as Exclude<Docker, 'ready'>] });
    const limitMs = options.runLimitMs ?? 120_000;
    tell({ run, started: 'run', limitMs });
    tell({ run, stream: 'stdout', text: "What's your name? " });
    return new Promise((resolve) => {
      const end = (r: { exit: number; timedOut?: boolean; stopped?: boolean }) => {
        clearTimeout(timer);
        programs.delete(run);
        resolve({ kind: 'ran', stage: 'run', flooded: false, outOfMemory: false, timedOut: false, stopped: false, ...r });
      };
      const timer = setTimeout(() => end({ exit: 137, timedOut: true }), limitMs);
      programs.set(run, {
        input: (text) => {
          tell({ run, stream: 'stdout', text: `Hello, ${text.trim()}!\n` });
          end({ exit: 0 });
        },
        stop: () => end({ exit: 137, stopped: true }),
      });
    });
  }
  const progress = (run: string | undefined, phase: CheckProgress['phase'], total: number) => {
    for (let done = 0; done <= total; done++) progressListeners.forEach((l) => l({ ...(run ? { run } : {}), phase, done, total }));
  };

  /**
   * An io activity's visible tests, each reported as it finishes, like core: the program greets by name once the
   * learner replaced the placeholder, and prints a bare "Hello, !" before.
   */
  function ioTests(run: string | undefined, activity: Activity): TestView[] {
    const done = !activity.files[0].text.includes(PLACEHOLDER);
    const total = activity.visibleTests.length;
    progressListeners.forEach((l) => l({ ...(run ? { run } : {}), phase: 'visible', done: 0, total }));
    return activity.visibleTests.map((t, i) => {
      const actual = done ? (t.expected ?? '') : 'Hello, !\n';
      const status = done ? ('pass' as const) : ('fail' as const);
      const test = { name: `visible/${t.name}`, status, ...(done ? {} : { message: 'Output differs from the expected output.' }), actual };
      progressListeners.forEach((l) => l({ ...(run ? { run } : {}), phase: 'visible', done: i + 1, total, test }));
      return { hidden: false, name: test.name, status, ...(done ? {} : { message: test.message, actual }) };
    });
  }

  /** The agent the learner last tried to connect: once it's signed in, it connects. */
  let tried: AgentId | undefined;
  /** Installs Codemm started, one step further on each look. */
  const installs = new Map<AgentId, AgentInstall>();
  const AGENT_STEPS: AgentInstall[] = [{ phase: 'downloading', progress: 0.4 }, { phase: 'checking' }, { phase: 'installing' }];
  const desktopHost = () => (options.platform ?? hostPlatform()) !== 'linux';

  return {
    async installAgent(id) {
      const agent = agents.find((a) => a.id === id)!;
      if (!agent.canInstall || !desktopHost() || agent.state !== 'missing') return;
      installs.set(id, { phase: 'downloading', progress: 0 });
    },

    async signIn(id) {
      tried = id;
      // The learner signs in with the agent's own login; the next look sees it.
      if (options.agents?.[id] === 'signed-out') delete options.agents[id];
    },

    async agents() {
      // Installed or removed meanwhile, as in a terminal: an agent Codemm is installing follows its install instead.
      for (const a of agents.filter((x) => !installs.has(x.id))) {
        if (options.agents?.[a.id] === 'missing') a.state = 'missing';
        else if (a.state === 'missing') a.state = 'not-connected';
      }
      for (const [id, install] of installs) {
        if (install.phase === 'done' || install.phase === 'failed') continue;
        const next = AGENT_STEPS[AGENT_STEPS.findIndex((s) => JSON.stringify(s) === JSON.stringify(install)) + 1];
        if (next) installs.set(id, next);
        else if (options.agentInstallProblem) installs.set(id, { phase: 'failed', problem: options.agentInstallProblem });
        else {
          installs.set(id, { phase: 'done' });
          // A fresh install isn't signed in yet: the learner signs in with the agent's own login.
          tried = id;
          agents.find((a) => a.id === id)!.state = 'signed-out';
          options.agents = { ...options.agents, [id]: 'signed-out' };
        }
      }
      // A signed-out agent is checked again on every look, as main does.
      for (const a of agents.filter((x) => x.state === 'signed-out' && options.agents?.[x.id] !== 'signed-out')) {
        a.state = tried === a.id ? 'connected' : 'not-connected';
        if (a.state === 'connected') agents.filter((x) => x !== a && x.state === 'connected').forEach((x) => (x.state = 'not-connected'));
      }
      const seen = agents.map((a) => ({
        ...a,
        canInstall: a.canInstall && desktopHost(),
        ...(installs.has(a.id) ? { install: installs.get(a.id) } : {}),
        state: a.state === 'connected' && options.agentProblem === 'signed-out' ? 'signed-out' : a.state,
        untested: Boolean(options.untested) && a.state !== 'missing',
      }));
      // An agent connected again, signed in elsewhere, ends a sign-out stall, as in main.
      if (options.stalled === 'signed-out' && seen.some((a) => a.state === 'connected')) delete options.stalled;
      // This look sees the agents as they were; the next one, a change made meanwhile.
      happen('look');
      return seen;
    },

    onCheckProgress(listener) {
      progressListeners.add(listener);
      return () => void progressListeners.delete(listener);
    },

    onRunOutput(listener) {
      runListeners.add(listener);
      return () => void runListeners.delete(listener);
    },

    async runProgram(activityId, run) {
      const { activity } = find(activities, activityId);
      if (!activity.run) throw new Error("This track has no run command, so Run isn't available.");
      return greet(run);
    },

    async runExampleLive(lessonId, index, run) {
      const lesson = find(lessons, lessonId);
      if (!lesson.examples[index - 1] || lesson.style !== 'io') throw new Error(`Lesson "${lessonId}" has no example ${index}.`);
      return greet(run);
    },

    // The mock's programs read one line each, so there's no more input to end.
    async endRunInput() {},

    async sendRunInput(run, text) {
      const program = programs.get(run);
      program?.input(text);
      return program !== undefined;
    },

    async stopRun(run) {
      programs.get(run)?.stop();
    },

    onJobProgress(listener) {
      jobListeners.add(listener);
      return () => void jobListeners.delete(listener);
    },

    async jobProgress() {
      return [...jobs.values()];
    },

    async chooseModel(id, model) {
      const agent = agents.find((a) => a.id === id)!;
      if (!agent.models.some((m) => m.id === model)) throw new Error(`${model} isn't a tested model for ${agent.name}.`);
      agent.model = model;
      return { ...agent, untested: Boolean(options.untested) && agent.state !== 'missing' };
    },

    // Connecting runs the agent's sign-in check. Passing it also ends a
    // mid-session sign-out: the learner has signed in again.
    async connect(id) {
      tried = id;
      const agent = agents.find((a) => a.id === id)!;
      if (agent.state !== 'missing') {
        agent.state = options.agents?.[id] === 'signed-out' ? 'signed-out' : 'connected';
        if (agent.state === 'connected') {
          if (options.agentProblem === 'signed-out') delete options.agentProblem;
          if (options.stalled === 'signed-out') delete options.stalled;
          agents.filter((a) => a.id !== id && a.state === 'connected').forEach((a) => (a.state = 'not-connected'));
        }
      }
      return { ...agent, untested: Boolean(options.untested) && agent.state !== 'missing' };
    },

    async installDocker() {
      // With Docker Desktop installed, Windows' Install is WSL's setup alone.
      install = WSL_SETUP.has(docker()) ? { phase: 'wsl' } : { phase: 'downloading', progress: 0 };
    },

    async openDocker() {
      if (docker() === 'stopped') dockerNow = 'starting';
    },

    async openWindowsUpdate() {},

    async restartWindows() {},

    async computer() {
      const platform = options.platform ?? hostPlatform();
      const d = docker();
      const reported = install;
      // The next check sees Docker one step further along.
      if (install?.phase === 'wsl') {
        // A WSL just set up runs after a restart; one just updated, at once.
        [install, dockerNow] = d === 'wsl-missing' ? [{ phase: 'failed', problem: 'restart' }, 'wsl-restart'] : [{ phase: 'starting' }, 'starting'];
      } else if (install?.phase === 'starting') {
        install = undefined;
        dockerNow = options.dockerWontStart ? 'stopped' : 'ready';
      } else if (install && install.phase !== 'failed') {
        install = INSTALL_STEPS[INSTALL_STEPS.findIndex((s) => JSON.stringify(s) === JSON.stringify(install)) + 1];
        if (install?.phase === 'starting') dockerNow = 'starting';
      } else if (dockerNow === 'starting') dockerNow = 'ready';
      const failing = { missing: 0, stopped: 1, starting: 1, 'windows-containers': 1, 'wsl-missing': 1, 'wsl-old': 1, virtualization: 1, 'wsl-restart': 1, 'no-sandbox': 2, 'sandbox-checking': 2, 'sandbox-offline': 2, 'sandbox-folder': 2, ready: Infinity }[d];
      const checks = (['docker-installed', 'docker-running', 'sandbox'] as const).map((id, i) => ({
        id,
        state: i < failing ? ('ok' as const) : i === failing ? ('problem' as const) : ('waiting' as const),
        ...(i === failing && (d === 'starting' || d === 'windows-containers' || d === 'wsl-missing' || d === 'wsl-old' || d === 'virtualization') ? { detail: d } : {}),
        ...(i === failing && d === 'wsl-restart' ? { detail: 'restart' as const } : {}),
        ...(i === failing && d === 'sandbox-checking' ? { detail: 'checking' as const } : {}),
        ...(i === failing && SANDBOX_REASON[d] ? { reason: SANDBOX_REASON[d] } : {}),
      }));
      const canInstall = platform !== 'linux';
      const ready = checks.every((c) => c.state === 'ok');
      return { platform, checks, ready, ...(canInstall ? { canInstall } : {}), ...(reported ? { install: reported } : {}), ...(d === 'missing' && options.wasi ? { wasi: true as const } : {}) };
    },

    async tracks() {
      return tracks.map((t) => ({ ...t }));
    },

    async research(goal) {
      agentJob();
      if (research?.topic !== goal.topic) research = { topic: goal.topic, calls: 0, job: `mock-${++jobCount}`, review: `mock-${++jobCount}`, started: Date.now() };
      // What research looks at, a step per call (per `slow` calls when slow): the last step saves.
      const all: JobStep[] = [
        { kind: 'search', query: `${goal.topic} roadmap` }, { kind: 'read', url: 'roadmap.sh/react' }, { kind: 'read', url: 'react.dev/learn' },
        step('Checking the installed tracks'), step('Saving the roadmap'),
      ];
      const reported = (n: number): JobProgress => ({
        job: research!.job, kind: 'research', stage: n === all.length ? 2 : 1, steps: all.slice(0, n).reverse(), count: n, thinking: n !== all.length,
        elapsedMs: Date.now() - research!.started + quietMs(), idleMs: quietMs(),
      });
      const shown = options.slow ? all.length * options.slow : 2;
      if (++research.calls <= shown) {
        tellJob(reported(options.slow ? Math.ceil(research.calls / options.slow) : research.calls));
        return { state: 'running' };
      }
      if (research.calls === shown + 1) tellJob({ ...reported(all.length), ended: true });
      const beat = Math.ceil((research.calls - shown) / (options.slow || 1));
      const review = report(research.review, 'review', BEATS.review.slice(0, beat), research.started);
      if (beat <= BEATS.review.length) {
        tellJob(review);
        return { state: 'running' };
      }
      tellJob({ ...review, ended: true });
      roadmap = {
        // As an agent would title it: the live app shows the agent's title (§4.13).
        title: shownTopic(goal.topic),
        goal: goal.topic,
        track: goal.topic,
        activities: goal.practice !== 'none',
        installed: tracks.some((t) => t.name === goal.topic),
        concepts: TOPICS.map(([title, requires]) => ({ id: slugOf(title), title, requires: [...requires] })),
        sources: [],
      };
      drafting = true;
      return { state: 'done', roadmap: structuredClone(roadmap) };
    },

    async reviseRoadmap(edited, request) {
      agentJob();
      if (!roadmap) throw new Error('No roadmap');
      await playThrough('roadmap');
      roadmap = { ...roadmap, concepts: addTopic(edited, request) };
      return { roadmap: structuredClone(roadmap), changed: true, text: '' };
    },

    async approve(edited) {
      if (!roadmap) throw new Error('No roadmap');
      roadmap = { ...roadmap, concepts: structuredClone(edited) };
      approved = structuredClone(roadmap);
      drafting = false;
      lessons = new Map();
      activities = new Map();
      deferred = new Set();
      course = { title: roadmap.title, goal: roadmap.goal, track: roadmap.track, activities: roadmap.activities, setup: !roadmap.activities || roadmap.installed ? 'ready' : 'proposing', done: false, topics: edited.map(addConcept) };
      current = `course-${kept.size + 1}`;
      kept.set(current, { course, approved, lessons, activities, deferred });
      advance();
      happen('approve');
    },

    async courses() {
      return [...kept].map(([id, k]) => ({ id, title: k.course.title, goal: k.course.goal, track: k.course.track, current: id === current }));
    },

    async switchCourse(id) {
      const k = kept.get(id);
      if (!k) throw new Error('No such course.');
      ({ course, approved, lessons, activities, deferred } = k);
      current = id;
    },

    async draft() {
      return drafting && roadmap ? structuredClone(roadmap) : null;
    },

    async saveDraft(edited) {
      if (!drafting || !roadmap) throw new Error('No roadmap to edit.');
      roadmap = { ...roadmap, concepts: structuredClone(edited) };
    },

    async course() {
      if (!course) return null;
      tick(course);
      return { ...structuredClone(course), topics: course.topics.map((t) => ({ ...structuredClone(t), ...(!course!.activities ? { activity: 'none' as const, stuck: false } : {}) })), ...(options.stalled ? { stalled: options.stalled } : {}), ...(options.stalled && options.stalledWork ? { stalledWork: options.stalledWork } : {}), ...(options.stalled && options.laterTopic ? { later: options.laterTopic } : {}) };
    },

    async setActivities(on) {
      if (!course) throw new Error('No course');
      course.activities = on;
      course.setup = !on || tracks.some((t) => t.name === course!.track) ? 'ready' : 'proposing';
      advance();
    },

    async install(digest) {
      if (!course?.proposal || course.proposal.digest !== digest) throw new Error('The setup changed. Look at it again.');
      // A retry after the learner fixed the problem (back online, or freed disk space).
      if (course.setup === 'failed') delete options.setupProblem;
      delete course.setupProblem;
      course.setup = 'installing';
    },

    async retrySetup() {
      if (!course) throw new Error('No course');
      agentJob();
      delete options.setupProblem;
      delete course.setupProblem;
      course.setup = 'proposing';
    },

    async retryJobs() {
      delete options.agentProblem;
      delete options.stalled;
      delete options.stalledWork;
      delete options.laterTopic;
    },

    async lesson(id) {
      return structuredClone(find(lessons, id));
    },

    async saveNotes(id, notes) {
      find(lessons, id).notes = notes;
    },

    async markRead(id) {
      const lesson = find(lessons, id);
      const ref = topicOf(lesson.concept).lessons.find((l) => l.id === id)!;
      if (ref.state !== 'writing') ref.state = 'read';
      if (!course!.activities) {
        deferred.delete(lesson.concept);
        advance();
      }
      unlock(lesson.concept);
    },

    async activity(concept) {
      // The newest: a topic gets a new activity after each pass that doesn't master it.
      const record = [...activities.values()].reverse().find((r) => r.activity.concept === concept);
      if (!record) throw new Error(`No activity for ${concept}`);
      return structuredClone(record.activity);
    },

    async saveFile(activityId, path, text, digest) {
      const file = find(activities, activityId).activity.files.find((f) => f.path === path);
      if (!file) throw new Error(`Not a file of this activity: ${path}`);
      if (file.digest !== digest) throw new Error(CHANGED);
      file.text = text;
      file.digest = digestOf(text);
      return file.digest;
    },

    async runExample(lessonId, index) {
      if (docker() !== 'ready') return { kind: 'not-run', reason: DOCKER_DOWN[docker() as Exclude<Docker, 'ready'>] };
      const example = find(lessons, lessonId).examples[index - 1];
      if (!example) throw new Error('No such example.');
      return { kind: 'ran', exit: 0, output: `${example.files.map((f) => f.path).join('\n')}\n`, errors: '' };
    },

    async tryIt(activityId, run) {
      const { activity } = find(activities, activityId);
      if (!counts()) return notCounted();
      if (activity.run) {
        const tests = ioTests(run, activity);
        return { kind: 'ran', passed: tests.filter((t) => t.status === 'pass').length, total: tests.length, tests };
      }
      progress(run, 'visible', activity.visibleTests.length);
      const done = !activity.files[0].text.includes(PLACEHOLDER);
      const tests: TestView[] = activity.visibleTests.map((t, i) => ({
        hidden: false,
        name: t.name,
        status: i === 0 || done ? 'pass' : 'fail',
        ...(i > 0 && !done ? { actual: 'Count: 0' } : {}),
      }));
      return { kind: 'ran', passed: tests.filter((t) => t.status === 'pass').length, total: tests.length, tests };
    },

    async check(activityId, run): Promise<CheckResult> {
      const record = find(activities, activityId);
      if (!counts()) return notCounted();
      if (++checks === 1) happen('check');
      if (!record.activity.run) progress(run, 'visible', 2);
      deferred.delete(record.activity.concept);
      const text = record.activity.files[0].text;
      const done = !text.includes(PLACEHOLDER);
      const unedited = text === STARTER;
      const topic = topicOf(record.activity.concept);
      if (!done && !unedited) record.fails++;
      if (done && topic.state !== 'mastered') {
        const passes = [...activities.values()].filter((r) => r.activity.concept === topic.id).length;
        if (passes >= (options.passes ?? 1)) {
          Object.assign(topic, { state: 'mastered', mastery: 1, activity: 'passed' });
          advance();
        } else {
          // Not mastered yet: the topic's next activity is written, then opens (tick).
          const next = exercise(topic.id, passes + 1);
          activities.set(next.id, { activity: next, fails: 0 });
          topic.activity = 'writing';
        }
      }
      topic.stuck = !done && record.fails >= 3;
      const visible = record.activity.run ? ioTests(run, record.activity) : [];
      progress(run, 'hidden', 0);
      const tests: TestView[] = record.activity.run ? [...visible, { hidden: true, index: 1, status: 'pass' }, { hidden: true, index: 2, status: done ? 'pass' : 'fail' }] : [
        { hidden: false, name: 'Shows Count: 0', status: 'pass' },
        { hidden: false, name: 'Adds one per click', status: done ? 'pass' : 'fail', ...(done ? {} : { actual: 'Count: 0' }) },
        { hidden: true, index: 1, status: 'pass' },
        { hidden: true, index: 2, status: done ? 'pass' : 'fail' },
      ];
      const requires = (id: string) => approved!.concepts.find((x) => x.id === id)?.requires ?? [];
      // Leaving this topic for later opens another: one ready already, or one after it (core §7).
      const met = (r: string) => topicOf(r).state === 'mastered' || r === topic.id || deferred.has(r);
      const later = course!.topics.some((t) => t !== topic && t.state !== 'mastered' && requires(t.id).every(met));
      return { kind: 'graded', passed: tests.filter((t) => t.status === 'pass').length, total: tests.length, tests, recorded: !unedited, stuck: topic.stuck, mastered: topic.state === 'mastered', later };
    },

    async ask(place, text) {
      agentJob();
      await playThrough('tutor');
      if ('lessonId' in place) {
        find(lessons, place.lessonId);
        return [{ from: 'codemm', text: 'Good question. Try it in the activity next.' }];
      }
      find(activities, place.activityId);
      const declined = /\b(fix|solve|answer|write)\b/i.test(text) ? 'In practice mode, you write the code. ' : '';
      return [{ from: 'codemm', text: `${declined}Look at what you pass to setCount.` }];
    },

    async skip(concept) {
      topicOf(concept);
      deferred.add(concept);
      // Leaving a stalled activity for later ends the stall, as live's skip does.
      delete options.stalled;
      delete options.stalledWork;
      delete options.laterTopic;
      advance();
    },

    async easier(concept) {
      agentJob();
      const stuck = topicOf(concept);
      const added: Concept = { id: `${concept}-basics`, title: `${stuck.title}: first steps`, requires: [] };
      if (course!.topics.some((t) => t.id === added.id)) return;
      const concepts = approved!.concepts;
      concepts.splice(concepts.findIndex((c) => c.id === concept), 0, added);
      concepts.find((c) => c.id === concept)!.requires.push(added.id);
      course!.topics.splice(course!.topics.indexOf(stuck), 0, addConcept(added));
      // A new prerequisite gives the stuck topic a fresh start (§4.2).
      stuck.stuck = false;
      for (const r of activities.values()) if (r.activity.concept === concept) r.fails = 0;
      advance();
    },

    // A job of its own, named for its track (§4.11); slow holds it for `slow` half seconds, so its states can be seen.
    async rebuild(ref) {
      const track = tracks.find((t) => t.ref === ref);
      if (!track) throw new Error(`Unknown track: ${ref}`);
      const job = `mock-${++jobCount}`;
      const started = Date.now();
      const at = (): JobProgress => ({ job, kind: 'rebuild', track: track.name, stage: 0, steps: [], count: 0, thinking: false, elapsedMs: Date.now() - started, idleMs: 0 });
      tellJob(at());
      if (options.slow) await new Promise((r) => setTimeout(r, options.slow! * 500));
      tellJob({ ...at(), ended: true });
    },

    // What a few jobs might report, to see the Usage section; nothing is counted.
    async usage() {
      if (!course) return null;
      return { kinds: {}, total: { input: 182_400, output: 12_300, cachedInput: 90_000, costUsd: 0.42, runs: 6 } };
    },

    update: async () => options.update ?? { kind: 'none' },
    async restartToUpdate() {
      if (options.update?.kind !== 'ready') throw new Error('No update is ready.');
    },
  };
}
