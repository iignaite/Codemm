// An in-memory CodemmApi, for tests and for clicking through screens in
// development (CODEMM_MOCK). Like the core, it never holds a solution or a
// hidden test: it grades by whether the learner replaced the starter's
// placeholder, and reports hidden results as statuses only.
import { type CheckProgress, type ResearchProgress, type RunOutput,
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
  { id: 'claude', name: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', models: modelChoices('claude'), model: modelFor('claude'), experimental: false },
  { id: 'codex', name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', models: modelChoices('codex'), model: modelFor('codex'), experimental: false },
  { id: 'cursor', name: 'Cursor', installUrl: 'https://cursor.com/docs/cli/installation', models: modelChoices('cursor'), model: modelFor('cursor'), experimental: true },
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
  let research: { topic: string; calls: number } | null = null;
  let roadmap: Roadmap | null = null;
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
    if (topic.activity === 'passed' || course?.setup !== 'ready') return;
    topic.activity = topic.lessons.every((l) => l.state === 'read') ? 'open' : 'locked';
  }

  /** The next topic: not mastered, every prerequisite mastered, and a deferred one only if nothing else is ready (§4.4). */
  function advance() {
    const c = course!;
    const requires = (id: string) => roadmap!.concepts.find((x) => x.id === id)?.requires ?? [];
    const ready = c.topics.filter((t) => t.state !== 'mastered' && requires(t.id).every((r) => topicOf(r).state === 'mastered'));
    c.topics.filter((t) => t.state === 'now').forEach((t) => (t.state = 'later'));
    c.done = c.topics.every((t) => t.state === 'mastered');
    const next = ready.find((t) => !deferred.has(t.id)) ?? ready[0];
    if (next) start(next.id);
  }

  // Background jobs advance one step each time the UI reads the course.
  function tick(c: CourseView) {
    if (c.setup === 'proposing') {
      c.setup = 'consent';
      c.proposal = { digest: digestOf(PROPOSAL_FILES.map((f) => f.text).join('')), retry: Boolean(c.proposal), files: PROPOSAL_FILES };
    } else if (c.setup === 'installing') {
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
    if (writing) writing.state = 'ready';
    if (now.activity === 'writing' && c.setup === 'ready') now.activity = 'locked';
    unlock(now.id);
  }

  // Progress as a real check reports it: each test, as counts only.
  const progressListeners = new Set<(p: CheckProgress) => void>();
  const researchListeners = new Set<(p: ResearchProgress) => void>();
  const runListeners = new Set<(o: RunOutput) => void>();
  const tell = (o: RunOutput) => runListeners.forEach((l) => l(o));
  /** Run's programs: each asks for a name and greets it. */
  const programs = new Map<string, { input(text: string): void; stop(): void }>();
  const progress = (run: string | undefined, phase: CheckProgress['phase'], total: number) => {
    for (let done = 0; done <= total; done++) progressListeners.forEach((l) => l({ ...(run ? { run } : {}), phase, done, total }));
  };

  return {
    async agents() {
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
      if (docker() !== 'ready') return { kind: 'not-run', reason: DOCKER_DOWN[docker() as Exclude<Docker, 'ready'>] };
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
    },

    async sendRunInput(run, text) {
      const program = programs.get(run);
      program?.input(text);
      return program !== undefined;
    },

    async stopRun(run) {
      programs.get(run)?.stop();
    },

    onResearchProgress(listener) {
      researchListeners.add(listener);
      return () => void researchListeners.delete(listener);
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
      if (research?.topic !== goal.topic) research = { topic: goal.topic, calls: 0 };
      if (++research.calls < 3) {
        const step: ResearchProgress = research.calls === 1 ? { kind: 'search', query: `${goal.topic} roadmap` } : { kind: 'read', url: 'roadmap.sh/react' };
        researchListeners.forEach((l) => l(step));
        return { state: 'running' };
      }
      roadmap = {
        goal: goal.topic,
        track: goal.topic,
        installed: tracks.some((t) => t.name === goal.topic),
        concepts: TOPICS.map(([title, requires]) => ({ id: slugOf(title), title, requires: [...requires] })),
        sources: [],
      };
      return { state: 'done', roadmap: structuredClone(roadmap) };
    },

    async reviseRoadmap(edited, request) {
      agentJob();
      if (!roadmap) throw new Error('No roadmap');
      roadmap = { ...roadmap, concepts: addTopic(edited, request) };
      return { roadmap: structuredClone(roadmap), changed: true, text: '' };
    },

    async approve(edited) {
      if (!roadmap) throw new Error('No roadmap');
      roadmap = { ...roadmap, concepts: structuredClone(edited) };
      lessons.clear();
      activities.clear();
      course = { goal: roadmap.goal, track: roadmap.track, setup: roadmap.installed ? 'ready' : 'proposing', done: false, topics: edited.map(addConcept) };
      advance();
      happen('approve');
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
      progress(run, 'visible', 2);
      progress(run, 'hidden', 0);
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
      const tests: TestView[] = [
        { hidden: false, name: 'Shows Count: 0', status: 'pass' },
        { hidden: false, name: 'Adds one per click', status: done ? 'pass' : 'fail', ...(done ? {} : { actual: 'Count: 0' }) },
        { hidden: true, index: 1, status: 'pass' },
        { hidden: true, index: 2, status: done ? 'pass' : 'fail' },
      ];
      return { kind: 'graded', passed: tests.filter((t) => t.status === 'pass').length, total: tests.length, tests, recorded: !unedited, stuck: topic.stuck, mastered: topic.state === 'mastered' };
    },

    async ask(place, text) {
      agentJob();
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
      const concepts = roadmap!.concepts;
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
