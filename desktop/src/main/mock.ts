// In-memory stand-in for the Codemm core, until the real core plugs in behind
// the same CodemmApi. It holds only learner-safe data: its grading is scripted
// (not yet, then passed), so it needs no solution and no hidden tests.
import type {
  Agent, CodemmApi, Course, Draft, Exercise, Graded, Lesson, Note, SourceFile, Topic, Track, VisibleTest,
} from '../shared/api';

const AGENTS: [string, string][] = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']];
const PATH = ['JavaScript basics', 'JSX', 'Components', 'Props', 'State', 'Events', 'Lists and keys', 'Forms'];

const LESSONS: Omit<Lesson, 'id' | 'topicId' | 'note'>[] = [
  { title: 'Values and variables', body: 'A variable gives a value a name, so you can use it again.', code: 'let count = 0;' },
  {
    title: 'useState',
    body: 'A value React remembers. Set it, and the screen updates.',
    code: 'const [count, setCount] = useState(0);',
    predict: { question: 'After two clicks, what does it show?', options: ['Count: 0', 'Count: 1', 'Count: 2'], answer: 2, shown: 'Count: 2' },
  },
];

const STARTER: SourceFile[] = [
  {
    path: 'Counter.jsx',
    content: [
      "import { useState } from 'react';", '',
      'export default function Counter() {',
      '  const [count, setCount] = useState(0);', '',
      '  function handleClick() {',
      '    setCount(/* your code */);',
      '  }', '',
      '  return (',
      '    <div>',
      '      <p>Count: {count}</p>',
      '      <button onClick={handleClick}>Add one</button>',
      '    </div>',
      '  );',
      '}', '',
    ].join('\n'),
  },
  { path: 'App.jsx', content: "import Counter from './Counter';\n\nexport default function App() {\n  return <Counter />;\n}\n" },
];

const SHOWS: VisibleTest = { name: 'Shows Count: 0', passed: true };
const ADDS_FAIL: VisibleTest = { name: 'Adds one per click', passed: false, expected: 'Count: 1', found: 'Count: 0' };
const ADDS_PASS: VisibleTest = { name: 'Adds one per click', passed: true };
const HINT: Note = { from: 'codemm', text: 'Look at what you pass to setCount.', line: 7 };

interface Options {
  delayMs?: number;
  /** The first setup attempt fails. */
  failSetup?: boolean;
}

export function createMockApi({ delayMs = 600, failSetup = false }: Options = {}): CodemmApi {
  const agents: Agent[] = AGENTS.map(([id, name]) => ({ id, name, state: 'available' }));
  const tracks: Track[] = [{ id: 'c', name: 'C' }, { id: 'java', name: 'Java' }];
  const courses = new Map<string, Course>();
  const lessons = new Map<string, Lesson>();
  const exercises = new Map<string, { exercise: Exercise; checks: number }>();
  const listeners = new Set<() => void>();
  let assist = false;
  let setupFails = failSetup;
  let n = 0;

  const id = (prefix: string) => `${prefix}${++n}`;
  const copy = <T>(v: T): T => structuredClone(v);
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  const emit = () => listeners.forEach((l) => l());
  const later = (fn: () => void, times = 1) => setTimeout(() => { fn(); emit(); }, delayMs * times);
  const find = <T>(map: Map<string, T>, key: string): T => {
    const v = map.get(key);
    if (!v) throw new Error(`Not found: ${key}`);
    return v;
  };

  function topicOf(topicId: string): [Course, Topic] {
    for (const c of courses.values()) {
      const t = c.topics.find((x) => x.id === topicId);
      if (t) return [c, t];
    }
    throw new Error(`Not found: ${topicId}`);
  }

  function openActivity(course: Course, topic: Topic) {
    if (course.setup !== 'ready' || topic.activity || topic.lessons.some((l) => l.state === 'writing')) return;
    const exercise: Exercise = {
      id: `ex-${topic.id}`, topicId: topic.id, title: 'Click Counter',
      statement: 'Make the count go up by one on each click.', example: 'Count: 3', files: copy(STARTER), assist,
    };
    exercises.set(exercise.id, { exercise, checks: 0 });
    topic.activity = exercise.id;
  }

  function writeLessons(course: Course, topic: Topic) {
    topic.lessons = LESSONS.map((l, i) => {
      const lesson: Lesson = { ...copy(l), id: id('l'), topicId: topic.id, note: '' };
      lessons.set(lesson.id, lesson);
      return { id: lesson.id, title: lesson.title, state: i === 0 ? 'ready' : 'writing' };
    });
    later(() => {
      topic.lessons.forEach((l) => { if (l.state === 'writing') l.state = 'ready'; });
      openActivity(course, topic);
    });
  }

  function setUp(course: Course) {
    course.setup = 'running';
    later(() => {
      if (setupFails) {
        setupFails = false;
        course.setup = 'failed';
        return;
      }
      course.setup = 'ready';
      if (!tracks.some((t) => t.name === course.track)) tracks.push({ id: course.track.toLowerCase(), name: course.track });
      course.topics.forEach((t) => t.state === 'now' && openActivity(course, t));
    }, 2);
  }

  function graded(passed: boolean, recorded: boolean, mastered = false): Graded {
    return {
      kind: 'graded', passed: passed ? 4 : 2, total: 4, recorded, mastered, stuck: false,
      visible: [SHOWS, passed ? ADDS_PASS : ADDS_FAIL],
      hidden: passed ? ['passed', 'passed'] : ['passed', 'failed'],
      ...(recorded && { note: passed ? { from: 'codemm', text: 'Every test passes.' } : HINT }),
    };
  }

  function master(exercise: Exercise) {
    const [course, topic] = topicOf(exercise.topicId);
    if (topic.state === 'mastered') return;
    topic.state = 'mastered';
    topic.mastery = 0.9;
    const next = course.topics.find((t) => t.state === 'later');
    if (next) {
      next.state = 'now';
      writeLessons(course, next);
    }
    course.review = course.topics.find((t) => t.state === 'mastered' && t.id !== topic.id)?.id;
  }

  const isStarter = (files: SourceFile[]) =>
    files.every((f) => STARTER.find((s) => s.path === f.path)?.content === f.content);

  return {
    async listAgents() { return copy(agents); },
    async connectAgent(agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`Not found: ${agentId}`);
      agent.state = 'connected';
      return copy(agent);
    },
    async suggestions() { return { learn: ['Rust', 'Go', 'Kotlin', 'Elixir'], known: ['Python', 'JavaScript'] }; },
    async listTracks() { return copy(tracks); },
    async rebuildTrack() { await wait(); },
    async research(goal) {
      await wait();
      const draft: Draft = {
        title: `${goal.topic} basics`,
        track: goal.topic,
        needsSetup: !tracks.some((t) => t.name.toLowerCase() === goal.topic.toLowerCase()),
        topics: PATH.map((title, i) => ({ id: id('t'), title, ...(i === 0 && goal.known[0] ? { known: goal.known[0] } : {}) })),
      };
      return { sources: [`${goal.topic} docs`, 'MDN Web Docs', 'Testing Library', 'Community roadmaps'], draft };
    },
    async reviseDraft(draft, request) {
      return { ...copy(draft), topics: [...draft.topics, { id: id('t'), title: request }] };
    },
    async approveDraft(draft) {
      const course: Course = {
        id: id('c'), title: draft.title, track: draft.track, setup: 'ready',
        topics: draft.topics.map((t, i) => ({ id: t.id, title: t.title, state: i ? 'later' : 'now', mastery: 0.5, lessons: [] })),
      };
      courses.set(course.id, course);
      if (draft.needsSetup) setUp(course);
      if (course.topics[0]) writeLessons(course, course.topics[0]);
      return copy(course);
    },
    async setUpTrack(courseId) {
      setUp(find(courses, courseId));
      emit();
    },
    async listCourses() { return [...courses.values()].map(({ id: cid, title }) => ({ id: cid, title })); },
    async getCourse(courseId) { return copy(find(courses, courseId)); },
    async openLesson(lessonId) {
      const lesson = find(lessons, lessonId);
      const [, topic] = topicOf(lesson.topicId);
      const ref = topic.lessons.find((l) => l.id === lessonId);
      if (ref && ref.state === 'ready') {
        ref.state = 'read';
        emit();
      }
      return copy(lesson);
    },
    async saveLesson(lessonId, edit) {
      const lesson = find(lessons, lessonId);
      Object.assign(lesson, { body: edit.body, note: edit.note });
      return copy(lesson);
    },
    async getExercise(exerciseId) { return { ...copy(find(exercises, exerciseId).exercise), assist }; },
    async saveFiles(exerciseId, files) {
      find(exercises, exerciseId).exercise.files = copy(files);
    },
    async test(exerciseId, files) {
      const entry = find(exercises, exerciseId);
      const ahead = entry.checks > 0 && !isStarter(files);
      return { kind: 'tested', visible: [SHOWS, ahead ? ADDS_PASS : ADDS_FAIL] };
    },
    async check(exerciseId, files) {
      const entry = find(exercises, exerciseId);
      entry.exercise.files = copy(files);
      if (isStarter(files)) return graded(false, false);
      entry.checks += 1;
      if (entry.checks < 2) return graded(false, true);
      master(entry.exercise);
      emit();
      return graded(true, true, true);
    },
    async hint() { return HINT; },
    async ask(where, text) {
      if ('exercise' in where && !assist && /fix|solve|answer|do it/i.test(text)) {
        return [{ from: 'codemm', text: 'In practice mode, you write the code.', lock: true }];
      }
      return [{ from: 'codemm', text: 'Good question. Try a small change, then run it.' }];
    },
    async setAssist(on) { assist = on; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
