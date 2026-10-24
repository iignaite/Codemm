import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, scenario } from '../../../main/mock';
import { renderApp } from '../../test-utils';
import type { DockerInstall } from '../../../shared/api';

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
    // The choice is named by the label it shows (WCAG 2.5.3).
    const choice = await screen.findByRole('radiogroup', { name: 'Your agent' });
    await user.click(within(choice).getByRole('radio', { name: 'Codex' }));
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

  it('on an older Windows, says why Docker stopped and opens Windows Update', async () => {
    const user = userEvent.setup();
    const api = createMock({ ...scenario('no-docker'), platform: 'windows' });
    const computer = api.computer;
    api.computer = async () => ({ ...(await computer()), install: { phase: 'failed', problem: 'windows-version' } });
    let opened = 0;
    api.openWindowsUpdate = async () => void opened++;
    renderApp({ to: 'setup' }, api);
    await user.click(await screen.findByRole('button', { name: "Install what's missing" }));
    const docker = screen.getByRole('listitem', { name: 'Docker Desktop' });
    expect(await within(docker).findByRole('alert')).toHaveTextContent('Docker no longer supports older versions, so update Windows first.');
    await user.click(within(docker).getByRole('button', { name: 'Open Windows Update' }));
    expect(opened).toBe(1);
  });

  it("on Windows, shows WSL's setup in Docker's card, and Try again when the learner said no to Windows' prompt", async () => {
    const user = userEvent.setup();
    const api = createMock({ ...scenario('no-docker'), platform: 'windows' });
    const computer = api.computer;
    let install: DockerInstall = { phase: 'wsl' };
    api.computer = async () => ({ ...(await computer()), install });
    renderApp({ to: 'setup' }, api);
    await user.click(await screen.findByRole('button', { name: "Install what's missing" }));
    const docker = screen.getByRole('listitem', { name: 'Docker Desktop' });
    expect(await within(docker).findByRole('progressbar', { name: 'Allow WSL, which Docker needs, when Windows asks (look in the taskbar).' })).toBeInTheDocument();
    install = { phase: 'failed', problem: 'declined' };
    expect(await within(docker).findByRole('alert')).toHaveTextContent('Windows asks for permission first. Try again, and choose Yes.');
    expect(within(docker).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    install = { phase: 'failed', problem: 'restart' };
    expect(await within(docker).findByText('Restart Windows, then open Codemm again.')).toBeInTheDocument();
  });
});

describe("Docker after Codemm's install", () => {
  it('says Docker Desktop is not installed before anything starts, with its terms and no pricing', async () => {
    renderApp({ to: 'setup' }, mac('no-docker'));
    const docker = await screen.findByRole('listitem', { name: 'Docker Desktop' });
    expect(within(docker).getByText('Not installed')).toBeInTheDocument();
    expect(docker).toHaveTextContent("Docker's terms apply. Read them");
    expect(docker).not.toHaveTextContent(/free/i);
  });

  it("once Docker's start window ends with Docker still stopped, offers to open it and check again, never a new download", async () => {
    const user = userEvent.setup();
    renderApp({ to: 'setup' }, mac('docker-wont-start'));
    await user.click(await screen.findByRole('button', { name: "Install what's missing" }));
    const docker = await screen.findByRole('listitem', { name: 'Docker Desktop' });
    // Installed, but Docker didn't answer within its start window: Codemm's install status is gone.
    expect(await within(docker).findByRole('button', { name: 'Open Docker Desktop' }, { timeout: 4000 })).toBeInTheDocument();
    expect(within(docker).getByText('Open Docker Desktop, then wait until it says it is running.')).toBeInTheDocument();
    expect(within(docker).getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(within(docker).queryByRole('progressbar')).not.toBeInTheDocument();
    // Opened, Docker starts, and Setup goes on.
    await user.click(within(docker).getByRole('button', { name: 'Open Docker Desktop' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' }, { timeout: 4000 })).toBeInTheDocument();
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
