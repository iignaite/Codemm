import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMock, scenario } from '../../../main/mock';
import { mockWithCourse, renderApp } from '../../test-utils';

describe('connect journey', () => {
  it('reaches the goal in three clicks: connect an agent, then continue past a ready computer', async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect an agent' }));

    expect(await screen.findByRole('heading', { name: 'Connect an agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    // No promise about billing: Codemm can't tell a plan from an API key.
    expect(screen.getByText('Codemm uses your agent and your account.')).toBeInTheDocument();
    const claude = screen.getByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Connect' }));
    expect(await within(claude).findByText('Connected')).toBeInTheDocument();
    // Read once: "Connected", not "Passed, Connected".
    expect(within(claude).queryByRole('img', { name: 'Passed' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Claude Code');
  });

  it('goes straight back to the course on a relaunch with one approved and the agent connected', async () => {
    const { api } = await mockWithCourse();
    renderApp({ to: 'welcome' }, api);
    expect(await screen.findByRole('list', { name: 'Topics' })).toBeInTheDocument();
    expect(screen.queryByText('Ready when you are.')).not.toBeInTheDocument();
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

  it('lets the learner choose a tested model for a connected agent, the recommended one preselected', async () => {
    const user = userEvent.setup();
    const api = createMock();
    renderApp({ to: 'connect' }, api);
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(within(claude).queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
    await user.click(within(claude).getByRole('button', { name: 'Connect' }));
    const model = await within(claude).findByRole('combobox', { name: 'Model' });
    expect(within(model).getAllByRole('option').map((o) => o.textContent)).toEqual(['Sonnet (recommended)', 'Opus', 'Haiku']);
    expect(model).toHaveValue('sonnet');
    await user.selectOptions(model, 'opus');
    await vi.waitFor(async () => expect((await api.agents()).find((a) => a.id === 'claude')?.model).toBe('opus'));
    expect(model).toHaveValue('opus');
    expect(within(screen.getByRole('listitem', { name: 'Codex' })).queryByRole('combobox')).not.toBeInTheDocument();
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

  it('offers Sign in, not a terminal command, and connects once the learner signed in and came back', async () => {
    const user = userEvent.setup();
    const options = scenario('signed-out');
    renderApp({ to: 'connect' }, createMock(options));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Connect' }));
    expect(await within(codex).findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(codex).not.toHaveTextContent(/terminal|codex login/);
    // Signed in from a terminal; coming back to Codemm checks again.
    options.agents = {};
    window.dispatchEvent(new Event('focus'));
    expect(await within(codex).findByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('links to each agent\'s install page when none is installed', async () => {
    // Linux: Codemm doesn't install agents there.
    renderApp({ to: 'connect' }, createMock({ ...scenario('no-agent'), platform: 'linux' }));
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(within(claude).getByText('Not installed')).toBeInTheDocument();
    expect(within(claude).getByRole('link', { name: 'Get Claude Code' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
    expect(within(screen.getByRole('listitem', { name: 'Codex' })).getByRole('link', { name: 'Get Codex' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Cursor' })).getByRole('link', { name: 'Get Cursor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});

describe('the only agent', () => {
  it('connects the only installed agent by itself, so Continue is the one click left', async () => {
    renderApp({ to: 'connect' }, createMock({ agents: { codex: 'missing', cursor: 'missing' } }));
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(await within(claude).findByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('lets the learner choose when more than one agent is installed', async () => {
    renderApp({ to: 'connect' }, createMock({ agents: { cursor: 'missing' } }));
    await screen.findByRole('listitem', { name: 'Claude Code' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});

describe('installing an agent', () => {
  it('installs a missing agent with progress, then signs in with its own login, and continues once signed in', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect', then: { to: 'goal' } }, createMock({ ...scenario('no-agent'), platform: 'mac' }));
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(within(claude).getByRole('link', { name: 'Get it myself' })).toHaveAttribute('href', 'https://code.claude.com/docs/en/setup');
    expect(within(screen.getByRole('listitem', { name: 'Cursor' })).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    await user.click(within(claude).getByRole('button', { name: 'Install' }));
    expect(await within(claude).findByRole('progressbar', { name: 'Downloading Claude Code' })).toBeInTheDocument();
    await user.click(await within(claude).findByRole('button', { name: 'Sign in' }, { timeout: 4000 }));
    // Signed in in the agent's own window; coming back to Codemm checks, then moves on as Continue does.
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('heading', { name: /^(Check this computer|What do you want to learn\?)$/ })).toBeInTheDocument();
  });

  it('says why an install stopped, with Try again and a way to do it by hand', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect' }, createMock({ ...scenario('agent-install-offline'), platform: 'mac' }));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Install' }));
    expect(await within(codex).findByText("You're offline. Connect to the internet, then try again.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(codex).getByRole('link', { name: 'Get it myself' })).toBeInTheDocument();
  });
});

describe('an install Codemm could not verify', () => {
  it('says so and offers Try again, claiming nothing about what ran', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect' }, createMock({ ...scenario('agent-install-offline'), agentInstallProblem: 'unverified', platform: 'mac' }));
    const codex = await screen.findByRole('listitem', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Install' }));
    expect(await within(codex).findByText("Codemm couldn't verify the installation. Try again.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(codex).not.toHaveTextContent(/signature|didn't use/);
    expect(within(codex).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('a relaunch', () => {
  it('opens on Welcome with the agent connected, read once: "Connected", not "Passed, Connected"', async () => {
    renderApp({ to: 'welcome' }, createMock(scenario('relaunch')));
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Passed' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Claude Code');
  });
});

describe('a look that fails after one worked', () => {
  it('keeps the agents on screen when a later look fails, says so, and Try again looks again', async () => {
    const user = userEvent.setup();
    const api = createMock();
    const agents = api.agents.bind(api);
    let failing = false;
    api.agents = () => (failing ? Promise.reject(new Error('codemm:offline')) : agents());
    renderApp({ to: 'connect' }, api);
    expect(await screen.findByRole('listitem', { name: 'Claude Code' })).toBeInTheDocument();
    failing = true;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText(/Codemm couldn't refresh this/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('listitem', { name: 'Claude Code' })).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Codemm couldn't refresh this/)).not.toBeInTheDocument());
  });
});
