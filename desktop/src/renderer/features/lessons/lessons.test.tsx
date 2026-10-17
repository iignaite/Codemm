import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../../main/mock';
import { readyCourse, renderWith } from '../../test/render';
import { LessonPage } from './LessonPage';
import { TopicPage } from './TopicPage';

describe('TopicPage', () => {
  it('lets the learner read while setup finishes, with the activity locked', async () => {
    const api = createMockApi({ delayMs: 2_000 });
    const { draft } = await api.research({ topic: 'React', known: [] });
    const course = await api.approveDraft(draft);
    const { user, go } = renderWith(<TopicPage topicId={course.topics[0].id} />, { api, courseId: course.id });
    expect(await screen.findByRole('heading', { name: 'JavaScript basics' })).toBeTruthy();
    expect(screen.getByText('Setting up React')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Locked' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Read Values and variables' }));
    expect(go).toHaveBeenCalledWith({ to: 'lesson', lessonId: course.topics[0].lessons[0].id });
  });

  it('opens the activity once the lessons are read', async () => {
    const api = createMockApi({ delayMs: 0 });
    const course = await readyCourse(api, { read: true });
    const { user, go } = renderWith(<TopicPage topicId={course.topics[0].id} />, { api, courseId: course.id });
    await user.click(await screen.findByRole('button', { name: 'Start the activity' }));
    expect(go).toHaveBeenCalledWith({ to: 'practice', exerciseId: course.topics[0].activity });
  });

  it('offers a way out when setup fails', async () => {
    const api = createMockApi({ delayMs: 0, failSetup: true });
    const course = await readyCourse(api, { needsSetup: true });
    const { user, go } = renderWith(<TopicPage topicId={course.topics[0].id} />, { api, courseId: course.id });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: "Couldn't set up React" })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(go).toHaveBeenCalledWith({ to: 'goal' });
  });
});

describe('LessonPage', () => {
  async function open() {
    const api = createMockApi({ delayMs: 0 });
    const course = await readyCourse(api, { read: true });
    const [first, second] = course.topics[0].lessons;
    return { course, first, second, ...renderWith(<LessonPage lessonId={second.id} />, { api, courseId: course.id }) };
  }

  it('asks for a prediction, then shows it', async () => {
    const { user } = await open();
    const predict = await screen.findByRole('region', { name: 'Predict' });
    const choice = within(predict).getByRole('button', { name: 'Count: 2' });
    await user.click(choice);
    expect(choice.getAttribute('aria-pressed')).toBe('true');
    expect(within(predict).getByRole('status').textContent).toContain('Count: 2');
  });

  it('keeps the learner’s edits and notes', async () => {
    const { user } = await open();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const note = screen.getByRole('textbox', { name: 'My note' });
    await user.type(note, 'the setter replaces the value');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('the setter replaces the value')).toBeTruthy();
  });

  it('moves through lessons, then to the activity', async () => {
    const { user, go, first } = await open();
    await user.click(await screen.findByRole('button', { name: 'Previous' }));
    expect(go).toHaveBeenCalledWith({ to: 'lesson', lessonId: first.id });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(go).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'practice' }));
  });

  it('has a Codemm rail without practice controls', async () => {
    await open();
    expect(await screen.findByRole('log')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
