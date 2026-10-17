import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { createMock } from '../../../main/mock';
import { renderApp } from '../../test-utils';

async function approved(options?: Parameters<typeof createMock>[0]): Promise<CodemmApi> {
  const api = createMock(options);
  await api.approve({ title: 'React basics', track: 'React', installed: false, topics: ['State', 'Events'] });
  return api;
}

describe('lessons', () => {
  it('opens the first lesson while the rest is still being written and set up', async () => {
    const api = await approved();
    renderApp({ to: 'topic', topicId: 't1' }, api);
    expect(await screen.findByRole('heading', { name: 'State' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read What state is' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Read useState' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Opens after the lessons' })).toBeInTheDocument();
    expect(screen.queryByText('Setting up React')).not.toBeInTheDocument();
  });

  it('predicts, keeps a note, and moves on to the activity once both lessons are read', async () => {
    const user = userEvent.setup();
    const api = await approved();
    for (let i = 0; i < 3; i++) await api.course();
    await api.read('t1.1');
    renderApp({ to: 'lesson', lessonId: 't1.2' }, api);

    expect(await screen.findByRole('heading', { name: 'useState', level: 1 })).toBeInTheDocument();
    const outline = screen.getByRole('navigation', { name: 'State' });
    expect(within(outline).getByRole('button', { name: 'useState' })).toHaveAttribute('aria-current', 'page');

    const answer = screen.getByRole('group', { name: 'Your answer' });
    expect(screen.queryByText('Count: 2', { selector: '.shows' })).not.toBeInTheDocument();
    await user.click(within(answer).getByRole('button', { name: 'Count: 2' }));
    expect(within(answer).getByRole('button', { name: 'Count: 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Count: 2', { selector: '.shows' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox', { name: 'My note' }), 'The setter replaces the value.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The setter replaces the value.')).toBeInTheDocument();
    expect((await api.lesson('t1.2')).note).toBe('The setter replaces the value.');

    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why a setter?{Enter}');
    expect(await within(screen.getByRole('log')).findByText('Good question. Try it in the activity next.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('says when setup failed, and retries', async () => {
    const user = userEvent.setup();
    const api = await approved({ setupFails: true });
    renderApp({ to: 'topic', topicId: 't1' }, api);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: "Couldn't set up React" })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try now' }));
    expect(await screen.findByRole('heading', { name: 'State' })).toBeInTheDocument();
  });
});
