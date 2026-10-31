// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../src/app';
import { quizFiles, quizRoadmap } from '../../../test/quiz-fixture';
import { desktopState } from './state';
import { fakeCore, live, until } from './testing/fakes';
import { tempDir } from './testing/temp';

afterEach(() => vi.unstubAllEnvs());

it('checks a quiz through live core without Docker, then opens a new quiz and restores the style', async () => {
  vi.stubEnv('CODEMM_HOME', tempDir());
  const ws = tempDir();
  await core.saveRoadmap(ws, 'quiz', quizRoadmap);
  await core.saveLesson(ws, { id: 'intro', concept: 'a', title: 'A', markdown: 'Read this.' });
  await core.markLessonRead(ws, 'intro');
  await core.saveExercise(ws, quizFiles());
  const state = desktopState(tempDir());
  state.update((s) => ({ ...s, approved: 'quiz', courses: ['quiz'] }));
  const dockerReady = vi.fn(async () => { throw new Error('Quiz must not wait for Docker'); });
  const t = live({ author: async () => {
    await core.saveExercise(ws, quizFiles('second'));
    return {};
  } }, { core: { ...fakeCore().app, ...core }, ws, state, dockerReady });
  await t.api.connect('claude');
  try {
    const activity = await t.api.activity('a');
    expect(activity.style).toBe('quiz');
    expect(JSON.stringify(activity)).not.toMatch(/correct|why/);
    const answers = Object.fromEntries(activity.style === 'quiz' ? activity.questions.map((q, i) => [i + 1, q.choices.findIndex((c) => c.text === 'Retry forever') + 1]) : []);
    await t.api.saveFile(activity.id, 'answers.yaml', JSON.stringify(answers), activity.files[0].digest);
    expect(await t.api.check(activity.id)).toMatchObject({ kind: 'graded', passed: 0, total: 5, recorded: true });
    await until(t.api, (c) => c.topics[0].activity === 'open');
    expect((await t.api.activity('a')).id).toBe('second');
    expect(dockerReady).not.toHaveBeenCalled();
    await t.api.setActivities(false);
    expect(core.getRoadmap(ws).style).toBe('none');
    await t.api.setActivities(true);
    expect(core.getRoadmap(ws).style).toBe('quiz');
    expect(core.getRoadmap(ws).track).toBeUndefined();
    expect(t.jobs.ran.map((j) => j.kind)).toEqual(['author']);
  } finally { await t.api.stop(); }
});
