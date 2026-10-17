import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Course } from '../../../shared/api';
import { createMockApi } from '../../../main/mock';
import { renderWith } from '../../test/render';
import { CourseMap } from './CourseMap';

const topic = (id: string, title: string, state: Course['topics'][number]['state'], mastery: number) => ({
  id, title, state, mastery, activity: 'ex-' + id, lessons: [{ id: 'l-' + id, title: 'Intro', state: 'read' as const }],
});
const course = (states: Course['topics'][number]['state'][]): Course => ({
  id: 'c1', title: 'React basics', track: 'React', setup: 'ready', review: 'p',
  topics: [topic('j', 'JSX', states[0], 0.9), topic('p', 'Props', states[1], 0.9), topic('s', 'State', states[2], 0.55)],
});

function withCourse(c: Course) {
  const api = createMockApi();
  vi.spyOn(api, 'getCourse').mockResolvedValue(c);
  return renderWith(<CourseMap />, { api, courseId: c.id });
}

describe('CourseMap', () => {
  it('shows each topic as mastered, now or later', async () => {
    withCourse(course(['mastered', 'now', 'later']));
    const map = await screen.findByRole('list');
    expect(within(map).getByRole('img', { name: 'Mastered' })).toBeTruthy();
    expect(within(map).getByRole('img', { name: 'Now' })).toBeTruthy();
    expect(within(map).getByRole('img', { name: 'Later' })).toBeTruthy();
  });

  it('continues the current topic and offers a review', async () => {
    const { user, go } = withCourse(course(['mastered', 'mastered', 'now']));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(go).toHaveBeenCalledWith({ to: 'practice', exerciseId: 'ex-s' });
    const review = screen.getByRole('region', { name: 'Review' });
    expect(within(review).getByText('Review Props')).toBeTruthy();
    await user.click(within(review).getByRole('button', { name: 'Review' }));
    expect(go).toHaveBeenLastCalledWith({ to: 'practice', exerciseId: 'ex-p' });
  });

  it('shows mastery in words for assistive tech', async () => {
    withCourse(course(['mastered', 'now', 'later']));
    const mastery = await screen.findByRole('region', { name: 'Mastery' });
    expect(within(mastery).getByRole('img', { name: 'JSX: mastered' })).toBeTruthy();
    expect(within(mastery).getByRole('img', { name: 'Props: in progress' })).toBeTruthy();
  });

  it('celebrates a finished course', async () => {
    const { user, go } = withCourse(course(['mastered', 'mastered', 'mastered']));
    expect(await screen.findByRole('heading', { name: 'React basics complete' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Learn something new' }));
    expect(go).toHaveBeenCalledWith({ to: 'goal' });
  });
});
