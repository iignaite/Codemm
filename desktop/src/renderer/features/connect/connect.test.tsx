import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('connect journey', () => {
  it('starts asleep, connects an agent, then wakes up', async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect an agent' }));

    expect(await screen.findByRole('heading', { name: 'Connect an agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    const claude = screen.getByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Connect' }));
    expect(await within(claude).findByText('Connected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Claude Code');
    await user.click(screen.getByRole('button', { name: 'Start learning' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('shows how to fix a failed sign-in', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect' }, createMock({ failAgent: 'codex' }));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Connect' }));
    expect(await within(codex).findByText('Not signed in. Sign in to Codex first.')).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
