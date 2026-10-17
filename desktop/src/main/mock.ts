// In-memory stand-in for the Codemm core, so the UI can be built and tested
// before the core is wired in. Like the core, it never holds a solution or a
// hidden test: it grades by whether the learner changed the starter, and
// reports hidden results as statuses only.
import {
  PLAN_LIMIT,
  SIGNED_OUT,
  type Activity,
  type Agent,
  type CheckResult,
  type CodeFile,
  type CodemmApi,
  type Course,
  type Draft,
  type Goal,
  type Lesson,
  type Message,
  type Platform,
  type Research,
  type Topic,
  type Track,
} from '../shared/api';

export interface MockOptions {
  /** Read on every call, so a test can change it while the app runs. */
  docker?: 'missing' | 'stopped' | 'no-sandbox' | 'ready';
  platform?: Platform;
  /** Agents that aren't installed, or whose sign-in check fails. */
  agents?: Partial<Record<string, 'missing' | 'signed-out'>>;
  /** Read on every call: agent jobs fail with this until it's cleared. */
  agentProblem?: 'signed-out' | 'plan-limit';
  setupProblem?: 'offline' | 'disk' | 'gates';
  /** Changes the options after the first approval or graded check, to act out a mid-session failure. */
  later?: { after: 'approve' | 'check'; set: Partial<MockOptions> };
}

/** Named environment states, for tests and for `CODEMM_MOCK` in development. */
export const SCENARIOS: Record<string, MockOptions> = {
  'no-docker': { docker: 'missing' },
  'docker-stopped': { docker: 'stopped' },
  'docker-stops': { later: { after: 'check', set: { docker: 'stopped' } } },
  'no-agent': { agents: { claude: 'missing', codex: 'missing', cursor: 'missing' } },
  'signed-out': { agents: { claude: 'signed-out', codex: 'signed-out', cursor: 'missing' } },
  'sign-in-expires': { later: { after: 'approve', set: { agentProblem: 'signed-out' } } },
  'plan-limit': { later: { after: 'approve', set: { agentProblem: 'plan-limit' } } },
  'offline-setup': { setupProblem: 'offline' },
  'low-disk': { setupProblem: 'disk' },
};

export function scenario(name: string | undefined): MockOptions {
  if (!name) return {};
  if (!Object.hasOwn(SCENARIOS, name)) throw new Error(`Unknown mock scenario: ${name}`);
  return structuredClone(SCENARIOS[name]);
}

const DOCKER_DOWN = {
  missing: "Docker isn't installed on this computer.",
  stopped: "Docker isn't running. Start it, then try again.",
  'no-sandbox': "Codemm couldn't confirm the sandbox. Restart Docker, then try again.",
};

function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'mac';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

// The model hint is a placeholder until the cross-model bench reports.
const MODEL_HINT = 'Minimum model to be confirmed.';
const AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude Code', state: 'not-connected', installUrl: 'https://code.claude.com/docs/en/setup', modelHint: MODEL_HINT },
  { id: 'codex', name: 'Codex', state: 'not-connected', installUrl: 'https://developers.openai.com/codex/cli', modelHint: MODEL_HINT },
  { id: 'cursor', name: 'Cursor', state: 'not-connected', installUrl: 'https://cursor.com/docs/cli/installation', modelHint: MODEL_HINT },
];

const PATH = ['JavaScript basics', 'JSX', 'Components', 'Props', 'State', 'Events', 'Lists and keys', 'Forms'];

const STARTER = `import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);

  function handleClick() {
    setCount(/* your code */);
  }

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={handleClick}>Add one</button>
    </div>
  );
}
`;

const HINT_LINE = 7;

function lessonsFor(topicId: string, title: string): Lesson[] {
  return [
    {
      id: `${topicId}.1`,
      topicId,
      title: `What ${title.toLowerCase()} is`,
      summary: `${title} in one idea, before any code.`,
      note: '',
    },
    {
      id: `${topicId}.2`,
      topicId,
      title: 'useState',
      summary: 'A value React remembers. Set it, and the screen updates.',
      code: 'const [count, setCount] = useState(0);',
      predict: { question: 'After two clicks, what does it show?', choices: ['Count: 0', 'Count: 1', 'Count: 2'], shows: 'Count: 2' },
      note: '',
    },
  ];
}

function activityFor(topicId: string, id = `${topicId}.a`, title = 'Click Counter'): Activity {
  return {
    id,
    topicId,
    title,
    prompt: 'Make the count go up by one on each click.',
    example: 'Count: 3',
    files: [
      { path: 'Counter.jsx', text: STARTER },
      { path: 'App.jsx', text: "import Counter from './Counter';\n\nexport default function App() {\n  return <Counter />;\n}\n" },
    ],
    assist: false,
  };
}

const same = (a: CodeFile[], b: CodeFile[]) => a.length === b.length && a.every((f, i) => f.path === b[i].path && f.text === b[i].text);

export function createMock(options: MockOptions = {}): CodemmApi {
  const agents = AGENTS.map((a) => ({ ...a, state: options.agents?.[a.id] === 'missing' ? 'missing' : a.state }));
  let researchCalls = 0;
  let checks = 0;
  const tracks: Track[] = [];
  const lessons = new Map<string, Lesson>();
  const activities = new Map<string, { activity: Activity; starter: CodeFile[]; fails: number }>();
  let research: Research | null = null;
  let course: Course | null = null;
  let setupTicks = 0;

  const find = <T>(map: Map<string, T>, id: string): T => {
    const value = map.get(id);
    if (!value) throw new Error(`Unknown id: ${id}`);
    return value;
  };
  const topicOf = (topicId: string): Topic => {
    const topic = course?.topics.find((t) => t.id === topicId);
    if (!topic) throw new Error(`Unknown topic: ${topicId}`);
    return topic;
  };
  const addActivity = (activity: Activity) => activities.set(activity.id, { activity, starter: activity.files, fails: 0 });

  // Background work advances one step each time the UI looks at the course.
  function tick(c: Course) {
    if (c.setup === 'running' && ++setupTicks >= 2) {
      c.setup = options.setupProblem ? 'failed' : 'ready';
      c.setupProblem = options.setupProblem;
      if (c.setup === 'ready' && !tracks.some((t) => t.name === c.track)) tracks.push({ id: c.track.toLowerCase(), name: c.track });
    }
    const now = c.topics.find((t) => t.state === 'now');
    if (!now) return;
    const writing = now.lessons.find((l) => l.state === 'writing');
    if (writing) writing.state = 'ready';
    unlock(now);
  }

  function unlock(t: Topic) {
    if (t.activity.state === 'passed' || course?.setup !== 'ready') return;
    t.activity.state = t.lessons.every((l) => l.state === 'read') ? 'open' : 'locked';
  }

  function start(t: Topic) {
    t.state = 'now';
    t.lessons.forEach((l, i) => (l.state = i === 0 ? 'ready' : 'writing'));
  }

  function pass(entry: { activity: Activity }): string {
    const topic = topicOf(entry.activity.topicId);
    if (topic.state === 'mastered') return `${topic.title} mastered.`;
    topic.activity.state = 'passed';
    topic.state = 'mastered';
    topic.mastery = 1;
    topic.activitiesLeft = 0;
    const next = course!.topics.find((t) => t.state === 'later');
    if (next) start(next);
    return `${topic.title} mastered.`;
  }

  /** Agent jobs (research, replies, hints) fail while the agent can't run. */
  function agentJob() {
    if (options.agentProblem === 'signed-out') throw new Error(SIGNED_OUT);
    if (options.agentProblem === 'plan-limit') throw new Error(PLAN_LIMIT);
  }

  function happen(after: 'approve' | 'check') {
    if (options.later?.after !== after) return;
    Object.assign(options, options.later.set);
    delete options.later;
  }

  return {
    async agents() {
      return agents.map((a) => ({ ...a, state: a.state === 'connected' && options.agentProblem === 'signed-out' ? 'signed-out' : a.state }));
    },

    // Connecting runs the agent's sign-in check. Passing it also ends a
    // mid-session sign-out: the learner has signed in again.
    async connect(agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      if (agent.state !== 'missing') {
        agent.state = options.agents?.[agentId] === 'signed-out' ? 'signed-out' : 'connected';
        if (agent.state === 'connected' && options.agentProblem === 'signed-out') delete options.agentProblem;
      }
      return { ...agent };
    },

    async computer() {
      const platform = options.platform ?? hostPlatform();
      const failing = { missing: 0, stopped: 1, 'no-sandbox': 2, ready: Infinity }[options.docker ?? 'ready'];
      const checks = (['docker-installed', 'docker-running', 'sandbox'] as const).map((id, i) => ({
        id,
        state: i < failing ? ('ok' as const) : i === failing ? ('problem' as const) : ('waiting' as const),
      }));
      return { platform, checks, ready: checks.every((c) => c.state === 'ok') };
    },

    async suggestions() {
      return { known: ['Python', 'JavaScript'], next: ['Rust', 'Go', 'Kotlin', 'Elixir'] };
    },

    async research(goal: Goal) {
      agentJob();
      if (!research || research.track !== goal.topic) {
        const because = goal.known[0] ? `You know ${goal.known[0]}` : undefined;
        research = {
          title: `${goal.topic} basics`,
          track: goal.topic,
          installed: tracks.some((t) => t.name === goal.topic),
          path: PATH.map((title, i) => (i === 0 && because ? { title, because } : { title })),
          done: false,
        };
        researchCalls = 0;
      }
      // The path fills in over a few calls.
      researchCalls++;
      research.done = researchCalls * 2 > PATH.length;
      return structuredClone({ ...research, path: research.path.slice(0, researchCalls * 2) });
    },

    async revise(draft: Draft, request) {
      agentJob();
      return { ...draft, topics: [...draft.topics, request] };
    },

    async approve(draft) {
      lessons.clear();
      activities.clear();
      setupTicks = 0;
      course = {
        title: draft.title,
        track: draft.track,
        setup: draft.installed ? 'ready' : 'running',
        topics: draft.topics.map((title, i) => {
          const id = `t${i + 1}`;
          const own = lessonsFor(id, title);
          own.forEach((l) => lessons.set(l.id, l));
          const activity = activityFor(id);
          addActivity(activity);
          return {
            id,
            title,
            state: 'later',
            mastery: 0,
            lessons: own.map((l) => ({ id: l.id, title: l.title, state: 'writing' })),
            activity: { id: activity.id, title: activity.title, state: 'writing' },
            activitiesLeft: 1,
          };
        }),
      };
      start(course.topics[0]);
      happen('approve');
      return structuredClone(course);
    },

    async setUp() {
      if (!course) throw new Error('No course');
      // A retry after the learner fixed the problem (back online, or freed disk space).
      delete options.setupProblem;
      delete course.setupProblem;
      course.setup = 'running';
      setupTicks = 0;
    },

    async course() {
      if (!course) return null;
      tick(course);
      return structuredClone(course);
    },

    async lesson(id) {
      return structuredClone(find(lessons, id));
    },

    async read(lessonId) {
      const lesson = find(lessons, lessonId);
      const topic = topicOf(lesson.topicId);
      const ref = topic.lessons.find((l) => l.id === lessonId)!;
      if (ref.state !== 'writing') ref.state = 'read';
      unlock(topic);
    },

    async saveNote(lessonId, note) {
      find(lessons, lessonId).note = note;
    },

    async activity(id) {
      return structuredClone(find(activities, id).activity);
    },

    async save(activityId, files) {
      find(activities, activityId).activity.files = structuredClone(files);
    },

    async run(activityId, files) {
      const entry = find(activities, activityId);
      return { output: same(files, entry.starter) ? 'Count: 0' : 'Count: 1' };
    },

    async check(activityId, files): Promise<CheckResult> {
      const entry = find(activities, activityId);
      entry.activity.files = structuredClone(files);
      const docker = options.docker ?? 'ready';
      if (docker !== 'ready') return { kind: 'not-counted', reason: DOCKER_DOWN[docker] };
      if (++checks === 1) happen('check');
      if (same(files, entry.starter)) {
        entry.fails++;
        return {
          kind: 'graded',
          passed: 2,
          total: 4,
          visible: [
            { name: 'Shows Count: 0', status: 'pass' },
            { name: 'Adds one per click', status: 'fail', expected: 'Count: 1', found: 'Count: 0' },
          ],
          hidden: ['pass', 'fail'],
          stuck: entry.fails >= 3,
        };
      }
      return {
        kind: 'graded',
        passed: 4,
        total: 4,
        visible: [
          { name: 'Shows Count: 0', status: 'pass' },
          { name: 'Adds one per click', status: 'pass' },
        ],
        hidden: ['pass', 'pass'],
        stuck: false,
        progress: pass(entry),
      };
    },

    async help(activityId, kind): Promise<Message> {
      agentJob();
      find(activities, activityId);
      return kind === 'hint'
        ? { from: 'codemm', text: 'Look at what you pass to setCount.', line: HINT_LINE }
        : { from: 'codemm', text: 'This line sets the next value.', line: HINT_LINE };
    },

    async ask(place, text) {
      agentJob();
      if ('lessonId' in place) {
        find(lessons, place.lessonId);
        return [{ from: 'codemm', text: 'Good question. Try it in the activity next.' }];
      }
      const { activity } = find(activities, place.activityId);
      if (!activity.assist && /\b(fix|solve|answer|write)\b/i.test(text)) {
        return [
          { from: 'codemm', text: 'In practice mode, you write the code.', locked: true },
          { from: 'codemm', text: 'Look at what you pass to setCount.', line: HINT_LINE },
        ];
      }
      return [{ from: 'codemm', text: 'Look at what you pass to setCount.', line: HINT_LINE }];
    },

    async assist(activityId, on) {
      // Assist is a setting: Codemm may then write code with the learner when
      // asked. The mock has no solution to write, so the files stay as they are.
      const entry = find(activities, activityId);
      entry.activity.assist = on;
      return structuredClone(entry.activity);
    },

    async easier(activityId) {
      agentJob();
      const { activity } = find(activities, activityId);
      const id = `${activityId}.easier`;
      if (!activities.has(id)) addActivity(activityFor(activity.topicId, id, `${activity.title}, one step`));
      return id;
    },

    async tracks() {
      return tracks.map((t) => ({ ...t }));
    },

    async rebuild(trackId) {
      if (!tracks.some((t) => t.id === trackId)) throw new Error(`Unknown track: ${trackId}`);
    },
  };
}
