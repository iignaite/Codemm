import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CodemmApi, Course } from '../../../shared/api';
import { mockWithCourse, renderApp } from '../../test-utils';

async function master(api: CodemmApi, topics: number) {
  for (let i = 0; i < topics; i++) {
    const course = (await api.course())!;
    const now = course.topics.find((t) => t.state === 'now')!;
    for (const l of now.lessons) await api.read(l.id);
    await api.course();
    const { id, files } = await api.activity(now.activity.id);
    await api.check(id, files.map((f) => ({ ...f, text: `${f.text} ` })));
  }
}

describe('course map', () => {
  it('shows mastered, current and later topics, and continues the current one', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    await master(api, 2);
    renderApp({ to: 'learn' }, api);
    const map = await screen.findByRole('list', { name: 'Topics' });
    const items = within(map).getAllByRole('listitem');
    expect(within(items[0]).getByRole('img', { name: 'Mastered' })).toBeInTheDocument();
    expect(within(items[2]).getByRole('img', { name: 'Now' })).toBeInTheDocument();
    expect(within(items[3]).getByRole('img', { name: 'Later' })).toBeInTheDocument();
    expect(within(items[2]).getByText('One more activity')).toBeInTheDocument();

    expect(screen.getByRole('img', { name: 'JavaScript basics: mastered' })).toBeInTheDocument();

    await user.click(within(items[2]).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Components' })).toBeInTheDocument();
  });

  it('celebrates a finished course, then offers something new', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse();
    await master(api, (course as Course).topics.length);
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('heading', { name: 'React basics complete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Learn something new' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });
});
