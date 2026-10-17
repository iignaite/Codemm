import { describe, expect, it, vi } from 'vitest';
import { API_METHODS } from '../shared/api';
import { createMockApi } from './mock';

const settle = () => new Promise((r) => setTimeout(r, 5));

async function startedCourse(needsSetup = false) {
  const api = createMockApi({ delayMs: 0 });
  const { draft } = await api.research({ topic: 'React', known: [] });
  const course = await api.approveDraft({ ...draft, needsSetup });
  await settle();
  return { api, course: await api.getCourse(course.id) };
}

async function openActivity() {
  const { api, course } = await startedCourse();
  const topic = course.topics[0];
  for (const l of topic.lessons) await api.openLesson(l.id);
  const id = (await api.getCourse(course.id)).topics[0].activity!;
  return { api, course, exercise: await api.getExercise(id) };
}

describe('mock CodemmApi', () => {
  it('implements every method in the IPC contract', () => {
    const api = createMockApi();
    for (const m of API_METHODS) expect(typeof api[m]).toBe('function');
    expect(typeof api.onChange).toBe('function');
  });

  it('connects an agent', async () => {
    const api = createMockApi();
    const [first] = await api.listAgents();
    expect(first.state).toBe('available');
    expect((await api.connectAgent(first.id)).state).toBe('connected');
    expect((await api.listAgents())[0].state).toBe('connected');
  });

  it('researches a draft that needs setup when no track matches', async () => {
    const api = createMockApi({ delayMs: 0 });
    const { sources, draft } = await api.research({ topic: 'React', known: ['Python'] });
    expect(sources.length).toBeGreaterThan(0);
    expect(draft.needsSetup).toBe(true);
    expect(draft.topics[0].known).toBe('Python');
  });

  it('sets up the track in the background and announces changes', async () => {
    const api = createMockApi({ delayMs: 0 });
    const changed = vi.fn();
    api.onChange(changed);
    const { draft } = await api.research({ topic: 'React', known: [] });
    const course = await api.approveDraft(draft);
    expect(course.setup).toBe('running');
    await settle();
    expect((await api.getCourse(course.id)).setup).toBe('ready');
    expect((await api.listTracks()).map((t) => t.name)).toContain('React');
    expect(changed).toHaveBeenCalled();
  });

  it('opens the activity only after its lessons are written', async () => {
    const { api, course } = await startedCourse();
    const topic = course.topics[0];
    expect(topic.state).toBe('now');
    expect(topic.lessons.every((l) => l.state === 'ready')).toBe(true);
    await api.openLesson(topic.lessons[0].id);
    expect((await api.getCourse(course.id)).topics[0].lessons[0].state).toBe('read');
  });

  it('keeps learner edits and notes on lessons', async () => {
    const { api, course } = await startedCourse();
    const id = course.topics[0].lessons[0].id;
    await api.saveLesson(id, { body: 'Mine', note: 'Remember this' });
    expect(await api.openLesson(id)).toMatchObject({ body: 'Mine', note: 'Remember this' });
  });

  it('does not count a check of the starter code', async () => {
    const { api, exercise } = await openActivity();
    const result = await api.check(exercise.id, exercise.files);
    expect(result).toMatchObject({ kind: 'graded', recorded: false });
  });

  it('grades a changed attempt, then passes and masters the topic', async () => {
    const { api, course, exercise } = await openActivity();
    const edited = exercise.files.map((f, i) => (i ? f : { ...f, content: f.content + '\n' }));
    const first = await api.check(exercise.id, edited);
    expect(first).toMatchObject({ kind: 'graded', recorded: true, passed: 2, total: 4 });
    const second = await api.check(exercise.id, edited);
    expect(second).toMatchObject({ kind: 'graded', passed: 4, total: 4, mastered: true });
    const after = await api.getCourse(course.id);
    expect(after.topics[0].state).toBe('mastered');
    expect(after.topics[1].state).toBe('now');
  });

  it('never reveals solutions or hidden test details', async () => {
    const { api, exercise } = await openActivity();
    const edited = exercise.files.map((f) => ({ ...f, content: f.content + ' ' }));
    const results = [await api.check(exercise.id, edited), await api.check(exercise.id, edited)];
    const payload = JSON.stringify([exercise, ...results]).toLowerCase();
    for (const word of ['solution', 'reference', 'mutant', 'hidden_', 'expected_output']) {
      expect(payload).not.toContain(word);
    }
    for (const r of results) {
      if (r.kind !== 'graded') throw new Error('expected a graded result');
      for (const h of r.hidden) expect(['passed', 'failed']).toContain(h);
    }
  });

  it('locks edits in practice mode until assist is on', async () => {
    const { api, exercise } = await openActivity();
    const [locked] = await api.ask({ exercise: exercise.id }, 'Just fix it for me.');
    expect(locked.lock).toBe(true);
    await api.setAssist(true);
    expect((await api.getExercise(exercise.id)).assist).toBe(true);
    const [open] = await api.ask({ exercise: exercise.id }, 'Just fix it for me.');
    expect(open.lock).toBeFalsy();
  });
});
