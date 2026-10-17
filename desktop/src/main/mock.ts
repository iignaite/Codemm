// In-memory stand-in for the Codemm core, so the UI can be built and tested
// before the core is wired in. Like the core, it never holds a solution or a
// hidden test: it grades by whether the learner changed the starter, and
// reports hidden results as statuses only.
import type {
  Activity,
  Agent,
  CheckResult,
  CodeFile,
  CodemmApi,
  Course,
  Draft,
  Goal,
  Lesson,
  Message,
  Research,
  Topic,
  Track,
} from '../shared/api';

export interface MockOptions {
  failAgent?: string;
  setupFails?: boolean;
  sandbox?: boolean;
}

const AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude Code', state: 'not-connected' },
  { id: 'codex', name: 'Codex', state: 'not-connected' },
  { id: 'cursor', name: 'Cursor', state: 'not-connected' },
];

const SOURCES = ['Official docs', 'MDN Web Docs', 'Testing Library', 'Community roadmaps'];
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
  const sandbox = options.sandbox ?? true;
  const agents = AGENTS.map((a) => ({ ...a }));
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
      c.setup = options.setupFails ? 'failed' : 'ready';
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
    const mastered = course!.topics.filter((t) => t.state === 'mastered');
    if (mastered.length > 1) course!.review = { topic: mastered[0].title, activityId: mastered[0].activity.id };
    return `${topic.title} mastered.`;
  }

  return {
    async agents() {
      return agents.map((a) => ({ ...a }));
    },

    async connect(agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`Unknown agent: ${agentId}`);
      if (agentId === options.failAgent) Object.assign(agent, { state: 'failed', fix: `Not signed in. Sign in to ${agent.name} first.` });
      else Object.assign(agent, { state: 'connected', fix: undefined });
      return { ...agent };
    },

    async suggestions() {
      return { known: ['Python', 'JavaScript'], next: ['Rust', 'Go', 'Kotlin', 'Elixir'] };
    },

    async research(goal: Goal) {
      if (!research || research.track !== goal.topic) {
        const because = goal.known[0] ? `You know ${goal.known[0]}` : undefined;
        research = {
          title: `${goal.topic} basics`,
          track: goal.topic,
          installed: tracks.some((t) => t.name === goal.topic),
          sources: SOURCES.map((name) => ({ name, read: false })),
          path: PATH.map((title, i) => (i === 0 && because ? { title, because } : { title })),
          done: false,
        };
      }
      const unread = research.sources.find((s) => !s.read);
      if (unread) unread.read = true;
      else research.done = true;
      // The path fills in as sources are read.
      const read = research.sources.filter((s) => s.read).length;
      const shown = research.done ? research.path : research.path.slice(0, read * 2);
      return structuredClone({ ...research, path: shown });
    },

    async revise(draft: Draft, request) {
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
      return structuredClone(course);
    },

    async setUp() {
      if (!course) throw new Error('No course');
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
      if (!sandbox) return { kind: 'not-counted', reason: "Docker isn't running. Start it, then try again." };
      if (same(files, entry.starter) && !entry.activity.assist) {
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
      find(activities, activityId);
      return kind === 'hint'
        ? { from: 'codemm', text: 'Look at what you pass to setCount.', line: HINT_LINE }
        : { from: 'codemm', text: 'This line sets the next value.', line: HINT_LINE };
    },

    async ask(place, text) {
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
      // The real core lets the learner's agent edit the files. The mock has no
      // solution to write, so the files stay as they are.
      const entry = find(activities, activityId);
      entry.activity.assist = on;
      return structuredClone(entry.activity);
    },

    async easier(activityId) {
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
