// An in-memory CodemmApi, for tests and for clicking through screens in
// development (CODEMM_MOCK). Like the core, it never holds a solution or a
// hidden test: it grades by whether the learner replaced the starter's
// placeholder, and reports hidden results as statuses only.
import { type CheckProgress, type JobKind, type JobProgress, type JobStep, type RunOutput, type RunResult,
  AGENT_FAILED,
  CHANGED,
  NO_AGENT,
  OFFLINE,
  PLAN_LIMIT,
  SIGNED_OUT,
  type Activity,
  type Agent,
  type AgentId,
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
import { addTopic } from '../shared/roadmap';

type Docker = 'missing' | 'stopped' | 'starting' | 'windows-containers' | 'no-sandbox' | 'ready';

export interface MockOptions {
  /** Read on every call, so a test can change it while the app runs. */
  docker?: Docker;
  platform?: Platform;
  /** Agents that aren't installed, or whose sign-in check fails. */
  agents?: Partial<Record<AgentId, 'missing' | 'signed-out'>>;
  /** Read on every call: agent jobs fail with this until it's cleared. */
  agentProblem?: 'signed-out' | 'plan-limit' | 'offline' | 'failed';
  untested?: boolean;
  setupProblem?: SetupProblem;
  /** Read on every call: background work stopped with this until the learner tries again or connects again. */
  stalled?: CourseView['stalled'];
  /** 'io': activities read input and print, so they have Run. */
  style?: 'io';
  /** Run's time limit; 120 s by default. */
  runLimitMs?: number;
  /**
   * Agent jobs take this many course reads per stage (and research per step), and calls such as a roadmap change
   * take this many half seconds, so each staged progress state can be seen (§4.11). Without it, jobs finish at once.
   */
  slow?: number;
  /** Every job has been quiet for over 90 seconds, so its "still working" line shows. */
  quiet?: boolean;
  /** Changes the options after the first approval or check, to act out a mid-session failure. */
  later?: { after: 'approve' | 'check'; set: Partial<MockOptions> };
}

/** Named environment states (D13), for tests and for `CODEMM_MOCK` in development. */
export const SCENARIOS: Record<string, MockOptions> = {
  'no-docker': { docker: 'missing' },
  'docker-stopped': { docker: 'stopped' },
  'docker-starting': { docker: 'starting' },
  'windows-containers': { docker: 'windows-containers', platform: 'windows' },
  'docker-stops': { later: { after: 'check', set: { docker: 'stopped' } } },
  'offline-setup': { setupProblem: 'offline' },
  'low-disk': { setupProblem: 'disk' },
  'setup-gates': { setupProblem: 'gates' },
  'no-agent': { agents: { claude: 'missing', codex: 'missing', cursor: 'missing' } },
  'signed-out': { agents: { claude: 'signed-out', codex: 'signed-out', cursor: 'missing' } },
  'sign-in-expires': { later: { after: 'approve', set: { agentProblem: 'signed-out' } } },
  'plan-limit': { later: { after: 'approve', set: { agentProblem: 'plan-limit' } } },
  'untested-version': { untested: true },
  'io-track': { style: 'io' },
  'run-time-up': { style: 'io', runLimitMs: 3000 },
  'slow-jobs': { slow: 4 },
  'quiet-jobs': { slow: 4, quiet: true },
};

const step = (label: string): JobStep => ({ kind: 'step', label });
/** What each mock job reports, beat by beat, as a real one would (§4.11). `codemm`: Codemm's own tool is running. */
type Beat = { stage: number; step?: JobStep; codemm?: true; retry?: JobProgress['retry']; part?: JobProgress['part'] };
const CHECKING = step('Codemm is checking the exercise');
const gate = (n: number, label: string, retry?: JobProgress['retry']): Beat => ({ stage: 2, step: step(label), codemm: true, part: { done: n, total: 3 }, ...(retry ? { retry } : {}) });
const BEATS: Record<Exclude<JobKind, 'research'> | 'install', Beat[]> = {
  roadmap: [{ stage: 0 }, { stage: 1, step: step('Reading the roadmap') }, { stage: 2, step: step('Saving the roadmap'), codemm: true }],
  setup: [{ stage: 0 }, { stage: 0, step: step('Checking the installed tracks') }, { stage: 0, step: step('Proposing the setup'), codemm: true }],
  install: [1, 2, 3, 4, 5].map((done): Beat => ({ stage: 1, codemm: true, part: { done, total: 5 } })).concat([{ stage: 2, codemm: true }]),
  lesson: [{ stage: 0 }, { stage: 1, step: step('Reading the roadmap') }, { stage: 2, step: step('Saving the lesson'), codemm: true }],
  author: [
    { stage: 0 },
    { stage: 1, step: step('Writing the exercise') },
    { stage: 2, step: CHECKING, codemm: true },
    gate(1, 'Codemm is checking that the reference passes'),
    gate(2, 'Codemm is checking that the starter fails'),
    { stage: 1, step: step('Writing the exercise'), retry: { attempt: 2, of: 3 } },
    { stage: 2, step: CHECKING, codemm: true, retry: { attempt: 2, of: 3 } },
    gate(3, 'Codemm is checking that the tests catch each broken version', { attempt: 2, of: 3 }),
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
  'no-sandbox': "Codemm couldn't confirm the sandbox.",
};

const AGENTS: Omit<Agent, 'state' | 'untested'>[] = [
  { id: 'claude', name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', signIn: 'claude auth login', models: modelChoices('claude'), model: modelFor('claude'), experimental: false },
  { id: 'codex', name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', signIn: 'codex login', models: modelChoices('codex'), model: modelFor('codex'), experimental: false },
  { id: 'cursor', name: 'Cursor', installUrl: 'https://cursor.com/docs/cli/installation', signIn: 'cursor-agent login', models: modelChoices('cursor'), model: modelFor('cursor'), experimental: true },
];

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
  const agents = AGENTS.map((a) => ({ ...a, state: (options.agents?.[a.id] === 'missing' ? 'missing' : 'not-connected') as Agent['state'] }));
  const tracks: Track[] = [];
  const lessons = new Map<string, Lesson>();
  const activities = new Map<string, { activity: Activity; fails: number }>();
  let research: { topic: string; calls: number; job: string; started: number } | null = null;
  /** The roadmap research wrote or the learner edited; a draft until approved. */
  let roadmap: Roadmap | null = null;
  let drafting = false;
  /** The approved course's roadmap: it stays the course while a new roadmap is a draft (§4.2). */
  let approved: Roadmap | null = null;
  let course: CourseView | null = null;
  let checks = 0;
  /** Concepts skipped since their last check (§4.4). */
  const deferred = new Set<string>();

  // Installing or opening Docker moves the mock's Docker along, one step per check (§6.1).
  let dockerNow: Docker | undefined;
  let install: DockerInstall | undefined;
  const INSTALL_STEPS: DockerInstall[] = [{ phase: 'downloading', progress: 0.6 }, { phase: 'checking' }, { phase: 'installing' }, { phase: 'starting' }];
  const docker = () => dockerNow ?? options.docker ?? 'ready';
  const notCounted = () => ({ kind: 'not-counted' as const, reason: DOCKER_DOWN[docker() as Exclude<Docker, 'ready'>] });
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

  function happen(after: 'approve' | 'check') {
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
    const activity: Activity = options.style === 'io' ? {
      id: `${concept.id}-easy-1`,
      concept: concept.id,
      title: 'Greet by name',
      statement: 'Read a name, then print `Hello, <name>!`.',
      visibleTests: [
        { name: '01', input: 'Ada\n', expected: 'Hello, Ada!\n' },
        { name: '02', input: 'Grace\n', expected: 'Hello, Grace!\n' },
      ],
      files: [{ path: 'main.py', text: IO_STARTER, digest: digestOf(IO_STARTER) }],
      run: 'python3 main.py',
    } : {
      id: `${concept.id}-easy-1`,
      concept: concept.id,
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
    activities.set(activity.id, { activity, fails: 0 });
    return { id: concept.id, title: concept.title, state: 'later' as const, mastery: 0, stuck: false, lessons: own.map((l) => ({ id: l.id, title: l.title, state: 'writing' as const })), activity: 'writing' as const };
  }

  function start(concept: string) {
    const topic = topicOf(concept);
    topic.state = 'now';
    topic.lessons.forEach((l, i) => (l.state = l.state === 'read' ? 'read' : i === 0 ? 'ready' : 'writing'));
  }

  function unlock(concept: string) {
    const topic = topicOf(concept);
    // An activity still being written opens once its author job ends (tick).
    if (topic.activity === 'passed' || topic.activity === 'writing' || course?.setup !== 'ready') return;
    topic.activity = topic.lessons.every((l) => l.state === 'read') ? 'open' : 'locked';
  }

  /** The next topic: not mastered, every prerequisite mastered, and a deferred one only if nothing else is ready (§4.4). */
  function advance() {
    const c = course!;
    const requires = (id: string) => approved!.concepts.find((x) => x.id === id)?.requires ?? [];
    const ready = c.topics.filter((t) => t.state !== 'mastered' && requires(t.id).every((r) => topicOf(r).state === 'mastered'));
    c.topics.filter((t) => t.state === 'now').forEach((t) => (t.state = 'later'));
    c.done = c.topics.every((t) => t.state === 'mastered');
    const next = ready.find((t) => !deferred.has(t.id)) ?? ready[0];
    if (next) start(next.id);
  }

  // Background jobs advance one step each time the UI reads the course.
  function tick(c: CourseView) {
    if (c.setup === 'proposing') {
      if (!busy('setup', 'setup')) {
        c.setup = 'consent';
        c.proposal = { digest: digestOf(PROPOSAL_FILES.map((f) => f.text).join('')), retry: Boolean(c.proposal), files: PROPOSAL_FILES };
      }
    } else if (c.setup === 'installing' && !busy('install', 'install')) {
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
    if (writing && !busy(`lesson:${now.id}`, 'lesson', now.id)) writing.state = 'ready';
    if (now.activity === 'writing' && c.setup === 'ready' && !busy(`author:${now.id}`, 'author', now.id)) now.activity = 'locked';
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

  return {
    async agents() {
      // A signed-out agent is checked again on every look, as main does.
      for (const a of agents.filter((x) => x.state === 'signed-out' && options.agents?.[x.id] !== 'signed-out')) {
        a.state = tried === a.id ? 'connected' : 'not-connected';
        if (a.state === 'connected') agents.filter((x) => x !== a && x.state === 'connected').forEach((x) => (x.state = 'not-connected'));
      }
      return agents.map((a) => ({
        ...a,
        state: a.state === 'connected' && options.agentProblem === 'signed-out' ? 'signed-out' : a.state,
        untested: Boolean(options.untested) && a.state !== 'missing',
      }));
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
      install = { phase: 'downloading', progress: 0 };
    },

    async openDocker() {
      if (docker() === 'stopped') dockerNow = 'starting';
    },

    async computer() {
      const platform = options.platform ?? hostPlatform();
      const d = docker();
      const reported = install;
      // The next check sees Docker one step further along.
      if (install?.phase === 'starting') {
        install = undefined;
        dockerNow = 'ready';
      } else if (install) {
        install = INSTALL_STEPS[INSTALL_STEPS.findIndex((s) => JSON.stringify(s) === JSON.stringify(install)) + 1];
        if (install?.phase === 'starting') dockerNow = 'starting';
      } else if (dockerNow === 'starting') dockerNow = 'ready';
      const failing = { missing: 0, stopped: 1, starting: 1, 'windows-containers': 1, 'no-sandbox': 2, ready: Infinity }[d];
      const checks = (['docker-installed', 'docker-running', 'sandbox'] as const).map((id, i) => ({
        id,
        state: i < failing ? ('ok' as const) : i === failing ? ('problem' as const) : ('waiting' as const),
        ...(i === failing && (d === 'starting' || d === 'windows-containers') ? { detail: d } : {}),
      }));
      const canInstall = platform !== 'linux';
      return { platform, checks, ready: checks.every((c) => c.state === 'ok'), ...(canInstall ? { canInstall } : {}), ...(reported ? { install: reported } : {}) };
    },

    async tracks() {
      return tracks.map((t) => ({ ...t }));
    },

    async research(goal) {
      agentJob();
      if (research?.topic !== goal.topic) research = { topic: goal.topic, calls: 0, job: `mock-${++jobCount}`, started: Date.now() };
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
      tellJob({ ...reported(all.length), ended: true });
      roadmap = {
        goal: goal.topic,
        track: goal.topic,
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
      lessons.clear();
      activities.clear();
      course = { goal: roadmap.goal, track: roadmap.track, setup: roadmap.installed ? 'ready' : 'proposing', done: false, topics: edited.map(addConcept) };
      advance();
      happen('approve');
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
      return { ...structuredClone(course), ...(options.stalled ? { stalled: options.stalled } : {}) };
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
      unlock(lesson.concept);
    },

    async activity(concept) {
      const record = [...activities.values()].find((r) => r.activity.concept === concept);
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
      if (docker() !== 'ready') return notCounted();
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
      if (docker() !== 'ready') return notCounted();
      if (++checks === 1) happen('check');
      if (!record.activity.run) progress(run, 'visible', 2);
      deferred.delete(record.activity.concept);
      const text = record.activity.files[0].text;
      const done = !text.includes(PLACEHOLDER);
      const unedited = text === STARTER;
      const topic = topicOf(record.activity.concept);
      if (!done && !unedited) record.fails++;
      if (done && topic.state !== 'mastered') {
        Object.assign(topic, { state: 'mastered', mastery: 1, activity: 'passed' });
        advance();
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
      const requires = (id: string) => roadmap!.concepts.find((x) => x.id === id)?.requires ?? [];
      const later = course!.topics.some((t) => t !== topic && t.state !== 'mastered' && requires(t.id).every((r) => topicOf(r).state === 'mastered'));
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
      find(activities, `${concept}-easy-1`).fails = 0;
      advance();
    },

    async rebuild(ref) {
      if (!tracks.some((t) => t.ref === ref)) throw new Error(`Unknown track: ${ref}`);
    },
  };
}
