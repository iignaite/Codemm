import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../../shared/api';
import { createMock, type MockOptions } from '../../../main/mock';
import { renderApp } from '../../test-utils';

const draft: Draft = { title: 'React basics', track: 'React', installed: false, topics: ['JavaScript basics', 'JSX', 'Props', 'State'] };
const names = () => screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));

describe('course editor', () => {
  it('renames, removes, adds and reorders topics without dragging', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'course', draft });
    expect(await screen.findByRole('heading', { name: 'React basics' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename Props' }));
    const name = screen.getByRole('textbox', { name: 'Topic name' });
    await user.clear(name);
    await user.type(name, 'Props and children');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Props and children', 'State']);

    await user.click(screen.getByRole('button', { name: 'Remove JSX' }));
    expect(names()).toEqual(['JavaScript basics', 'Props and children', 'State']);

    await user.click(screen.getByRole('button', { name: 'Move State' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveFocus();
    await user.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    expect(names()).toEqual(['JavaScript basics', 'State', 'Props and children']);

    await user.click(screen.getByRole('button', { name: 'Move JavaScript basics' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a topic' }));
    await user.type(screen.getByRole('textbox', { name: 'Topic name' }), 'Hooks{Enter}');
    expect(names()).toEqual(['JavaScript basics', 'State', 'Props and children', 'Hooks']);
  });

  it('cannot approve while a topic is being renamed', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'course', draft });
    await user.click(await screen.findByRole('button', { name: 'Rename Props' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('keeps the learner\'s edits when sign-in expires during a request', async () => {
    const user = userEvent.setup();
    const options: MockOptions = {};
    const api = createMock(options);
    await api.connect('claude');
    renderApp({ to: 'course', draft }, api);
    await user.click(await screen.findByRole('button', { name: 'Remove JSX' }));
    options.agentProblem = 'signed-out';
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'React basics' });
    expect(names()).toEqual(['JavaScript basics', 'Props', 'State']);
  });

  it('asks Codemm for changes', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'course', draft });
    await user.type(await screen.findByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    expect(await screen.findByRole('listitem', { name: 'Testing' })).toBeInTheDocument();
  });

  it('asks before setting up a track, then opens the first topic', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'course', draft });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Set up React on this computer?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('heading', { name: 'JavaScript basics' })).toBeInTheDocument();
  });
});
