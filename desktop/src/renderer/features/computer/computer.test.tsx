import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, scenario, type MockOptions } from '../../../main/mock';
import { isSafeLink } from '../../../main/links';
import { mockWithCourse, renderApp } from '../../test-utils';
import { FIXES } from './fixes';

const welcome = { to: 'welcome' } as const;

function open(options: MockOptions) {
  const user = userEvent.setup();
  renderApp({ to: 'computer', then: welcome }, createMock(options));
  return user;
}

describe('check this computer', () => {
  it('moves on by itself when the first check after Connect finds the computer ready', async () => {
    renderApp({ to: 'computer', then: { to: 'goal' }, fromConnect: true });
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('an explicit Check this computer that finds it ready says so, and waits for Continue', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'computer', then: { to: 'goal' } });
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('waits for Continue once the learner had a step to take', async () => {
    const options: MockOptions = { docker: 'stopped', platform: 'mac' };
    const user = open(options);
    await screen.findByRole('listitem', { name: 'Docker is running' });
    options.docker = 'ready';
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Docker is installed' })).getByText('Ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
  });

  it('shows the fix for this computer, links to the official page, and re-checks until Docker is ready', async () => {
    const options: MockOptions = { docker: 'missing', platform: 'windows' };
    const user = open(options);
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    expect(within(installed).getByText('Needs a step')).toBeInTheDocument();
    expect(within(installed).getByRole('button', { name: 'Install Docker' })).toBeInTheDocument();
    const link = within(installed).getByRole('link', { name: 'Install it myself' });
    expect(link).toHaveAttribute('href', 'https://docs.docker.com/desktop/setup/install/windows-install/');
    expect(within(screen.getByRole('listitem', { name: 'Docker is running' })).getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking again every few seconds.');

    options.docker = 'ready';
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
  });

  it('announces each change, and keeps focus when the focused step goes away', async () => {
    const options: MockOptions = { docker: 'missing', platform: 'mac' };
    open(options);
    const link = await screen.findByRole('link', { name: 'Install it myself' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Docker isn't installed yet. Checking again every few seconds."));
    link.focus();
    options.docker = 'stopped';
    expect(await screen.findByText("Docker isn't running yet. Checking again every few seconds.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toHaveFocus());
  });

  it('opens Docker Desktop when it is installed but not running, then waits while it starts', async () => {
    const user = open({ docker: 'stopped', platform: 'mac' });
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(running).toHaveTextContent('Open Docker Desktop');
    expect(within(screen.getByRole('listitem', { name: 'Docker is installed' })).getByText('Ready')).toBeInTheDocument();
    await user.click(within(running).getByRole('button', { name: 'Open Docker Desktop' }));
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
  });

  it('installs Docker for the learner on a Mac, showing each step, until the computer is ready', async () => {
    const user = open({ docker: 'missing', platform: 'mac' });
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    // Doing it by hand stays possible, on Docker's own page.
    expect(within(installed).getByRole('link', { name: 'Install it myself' })).toHaveAttribute('href', 'https://docs.docker.com/desktop/setup/install/mac-install/');
    await user.click(within(installed).getByRole('button', { name: 'Install Docker' }));
    expect(await within(installed).findByRole('progressbar', { name: 'Downloading Docker Desktop' })).toBeInTheDocument();
    expect(within(installed).getByText('Installing')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Installing Docker Desktop.');
    expect(await screen.findByText(/Checking it's from Docker/)).toBeInTheDocument();
    expect(await screen.findByText(/accept Docker's terms in its window/)).toBeInTheDocument();
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
  });

  it('says why an install stopped, and offers to try again', async () => {
    const api = createMock({ docker: 'missing', platform: 'windows' });
    const computer = api.computer;
    let problem: 'offline' | 'unverified' | 'restart' = 'offline';
    api.computer = async () => ({ ...(await computer()), install: { phase: 'failed', problem } });
    const user = userEvent.setup();
    renderApp({ to: 'computer', then: welcome }, api);
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    expect(await within(installed).findByText("You're offline. Connect to the internet, then try again.")).toBeInTheDocument();
    expect(within(installed).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    problem = 'unverified';
    expect(await within(installed).findByText("The download wasn't signed by Docker, so Codemm deleted it.")).toBeInTheDocument();
    problem = 'restart';
    expect(await within(installed).findByText('Restart Windows, then open Codemm again.')).toBeInTheDocument();
    expect(within(installed).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    void user;
  });

  it('offers no install on Linux', async () => {
    open({ docker: 'missing', platform: 'linux' });
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    expect(within(installed).queryByRole('button', { name: 'Install Docker' })).not.toBeInTheDocument();
    expect(within(installed).getByRole('link', { name: 'Get Docker Engine' })).toBeInTheDocument();
  });

  it('waits while Docker starts, and asks to switch from Windows containers', async () => {
    const options: MockOptions = scenario('docker-starting');
    const view = renderApp({ to: 'computer', then: welcome }, createMock(options));
    expect(await screen.findByRole('listitem', { name: 'Docker is running' })).toHaveTextContent('Docker is starting. This can take a few minutes.');
    expect(screen.getByRole('status')).toHaveTextContent('Docker is starting. Checking again every few seconds.');
    view.unmount();
    open(scenario('windows-containers'));
    expect(await screen.findByRole('listitem', { name: 'Docker is running' })).toHaveTextContent('Switch Docker Desktop to Linux containers');
  });

  it('gives Linux the start and docker group steps', async () => {
    open({ docker: 'stopped', platform: 'linux' });
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(running).toHaveTextContent('sudo systemctl start docker');
    expect(running).toHaveTextContent('sudo usermod -aG docker $USER');
  });

  it('asks to restart Docker when the sandbox check fails', async () => {
    open({ docker: 'no-sandbox', platform: 'mac' });
    const sandbox = await screen.findByRole('listitem', { name: 'The sandbox works' });
    expect(sandbox).toHaveTextContent('Restart Docker');
  });

  it('lets the learner carry on later', async () => {
    const user = open({ docker: 'stopped', platform: 'mac' });
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
  });

  it('opens from a check that was not counted, then goes back to the activity', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true, docker: 'stopped' });
    renderApp({ to: 'practice', concept: course.topics[0].id }, api);
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    const results = screen.getByRole('region', { name: 'Results' });
    await user.click(await within(results).findByRole('button', { name: 'Check this computer' }));
    expect(await screen.findByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('only links to official pages, and has a fix for every check on every platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      for (const id of ['docker-installed', 'docker-running', 'sandbox'] as const) {
        const fix = FIXES[platform][id];
        expect(fix?.steps.length).toBeGreaterThan(0);
        if (fix?.link) expect(isSafeLink(fix.link.url)).toBe(true);
      }
    }
  });
});

describe('re-checking', () => {
  it('runs one check at a time, even when the window regains focus', async () => {
    const api = createMock({ docker: 'stopped', platform: 'mac' });
    let calls = 0;
    let finish = () => {};
    const computer = api.computer;
    api.computer = () => {
      calls++;
      return calls === 1 ? computer() : new Promise((done) => (finish = () => done(computer())));
    };
    renderApp({ to: 'computer', then: { to: 'welcome' } }, api);
    await screen.findByRole('listitem', { name: 'Docker is running' });
    await waitFor(() => expect(calls).toBe(2));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    finish();
  });
});
