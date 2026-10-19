import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockWithCourse, mockWithRoadmap, renderApp } from '../test-utils';

const GOAL = 'Develop systematic thinking about React applications, from components to state';

describe('a course on screen', () => {
  it("is named by the learner's words, with the goal beneath them (W-5)", async () => {
    const { api } = await mockWithCourse();
    const course = api.course;
    api.course = async () => {
      const c = await course();
      return c && { ...c, goal: GOAL };
    };
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'React' })).toBeInTheDocument();
    expect(screen.getByText(GOAL)).toBeInTheDocument();
  });

  it('shows the roadmap under the same name, with its goal beneath', async () => {
    const { api, roadmap } = await mockWithRoadmap();
    renderApp({ to: 'course', roadmap: { ...roadmap, goal: GOAL } }, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'React' })).toBeInTheDocument();
    expect(screen.getByText(GOAL)).toBeInTheDocument();
  });

  it('shows no goal line when the goal is the name', async () => {
    const { api } = await mockWithCourse();
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'React' })).toBeInTheDocument();
    expect(screen.getAllByText('React')).toHaveLength(2);
  });
});
