import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, scenario } from '../../../main/mock';
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
    await screen.findByText('This computer is ready.');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Claude Code');
    await user.click(screen.getByRole('button', { name: 'Start learning' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('connects one agent at a time', async () => {
    const user = userEvent.setup();
    const api = createMock();
    let finish = () => {};
    const connect = api.connect;
    api.connect = (id) => new Promise((done) => (finish = () => done(connect(id))));
    renderApp({ to: 'connect' }, api);
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Connect' }));
    const codex = screen.getByRole('listitem', { name: 'Codex' });
    expect(within(codex).getByRole('button', { name: 'Connect' })).toBeDisabled();
    finish();
    expect(await within(claude).findByText('Connected')).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('shows the recommended model, marks Cursor experimental, and warns about untested versions', async () => {
    renderApp({ to: 'connect' }, createMock(scenario('untested-version')));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    expect(within(codex).getByText('Recommended: gpt-5.6-luna')).toBeInTheDocument();
    expect(within(codex).getByText('Untested version. It may still work.')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Cursor' })).getByText('Experimental')).toBeInTheDocument();
  });

  it('asks the learner to sign in to an agent, never for credentials', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect' }, createMock(scenario('signed-out')));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Connect' }));
    expect(await within(codex).findByText('Sign in to Codex, then try again.')).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('links to each agent\'s install page when none is installed', async () => {
    renderApp({ to: 'connect' }, createMock(scenario('no-agent')));
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(within(claude).getByText('Not installed')).toBeInTheDocument();
    expect(within(claude).getByRole('link', { name: 'Get Claude Code' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
    expect(within(screen.getByRole('listitem', { name: 'Codex' })).getByRole('link', { name: 'Get Codex' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Cursor' })).getByRole('link', { name: 'Get Cursor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
