import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, scenario } from '../../../main/mock';
import { renderApp } from '../../test-utils';

const mac = (name: string) => createMock({ ...scenario(name), platform: 'mac' });

describe('install what is missing', () => {
  it('offers one action on Welcome when Docker and an agent are missing', async () => {
    renderApp({ to: 'welcome' }, mac('nothing-installed'));
    expect(await screen.findByRole('button', { name: "Install what's missing" })).toBeInTheDocument();
  });

  it('installs Docker and the chosen agent, shows each, then Docker\'s terms window and the agent\'s sign-in in that order', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'welcome' }, mac('nothing-installed'));
    await user.click(await screen.findByRole('button', { name: "Install what's missing" }));
    const docker = await screen.findByRole('listitem', { name: 'Docker Desktop' });
    const agent = screen.getByRole('listitem', { name: 'Agent' });
    expect(within(agent).getByRole('radio', { name: 'Claude Code' })).toBeChecked();
    expect(within(docker).getByRole('link', { name: 'Read them' })).toBeInTheDocument();
    expect(within(agent).getByRole('link', { name: 'Read them' })).toHaveAttribute('href', 'https://www.anthropic.com/legal/consumer-terms');
    // Nothing downloads until the learner says so.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Install what's missing" }));
    // Docker's shows at once, at the start of its download; the agent's once its install reports.
    expect(await within(docker).findByRole('progressbar', { name: 'Downloading Docker Desktop' })).toBeInTheDocument();
    expect(within(docker).queryByText(/Opening Docker/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(2));
    expect(await within(docker).findByText(/accept Docker's terms in its window/, {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(await within(agent).findByRole('button', { name: 'Sign in' }, { timeout: 4000 }));
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' }, { timeout: 4000 })).toBeInTheDocument();
  });

  it('installs the agent the learner picks', async () => {
    const user = userEvent.setup();
    const api = mac('nothing-installed');
    renderApp({ to: 'setup' }, api);
    await user.click(await screen.findByRole('radio', { name: 'Codex' }));
    expect(within(screen.getByRole('listitem', { name: 'Agent' })).getByRole('link', { name: 'Read them' })).toHaveAttribute('href', 'https://openai.com/policies/');
    await user.click(screen.getByRole('button', { name: "Install what's missing" }));
    await screen.findAllByRole('progressbar');
    const agents = await api.agents();
    expect(agents.find((a) => a.id === 'codex')!.install).toBeDefined();
    expect(agents.find((a) => a.id === 'claude')!.install).toBeUndefined();
  });

  it('installs only what is missing: with an agent there, just Docker', async () => {
    renderApp({ to: 'setup' }, mac('no-docker'));
    expect(await screen.findByRole('listitem', { name: 'Docker Desktop' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Agent' })).not.toBeInTheDocument();
  });

  it('keeps the usual way in when nothing is missing', async () => {
    renderApp({ to: 'welcome' }, mac(''));
    expect(await screen.findByRole('button', { name: 'Connect an agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Install what's missing" })).not.toBeInTheDocument();
  });

  it('says why the agent install stopped, with Try again, beside Docker\'s own progress', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'setup' }, mac('nothing-installed-offline'));
    await user.click(await screen.findByRole('button', { name: "Install what's missing" }));
    const agent = screen.getByRole('listitem', { name: 'Agent' });
    expect(await within(agent).findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent("You're offline. Connect to the internet, then try again.");
    expect(within(agent).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('a look that fails after one worked', () => {
  it('keeps what is missing on screen when a later look fails, says so, and Try again looks again', async () => {
    const user = userEvent.setup();
    const api = mac('no-docker');
    const computer = api.computer.bind(api);
    let failing = false;
    api.computer = () => (failing ? Promise.reject(new Error('codemm:offline')) : computer());
    renderApp({ to: 'setup' }, api);
    expect(await screen.findByRole('listitem', { name: 'Docker Desktop' })).toBeInTheDocument();
    failing = true;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText(/Codemm couldn't refresh this/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('listitem', { name: 'Docker Desktop' })).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Codemm couldn't refresh this/)).not.toBeInTheDocument());
  });
});
