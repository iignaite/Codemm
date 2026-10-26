import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, scenario, type MockOptions } from '../../../main/mock';
import { isSafeLink } from '../../../main/links';
import { mockWithCourse, renderApp } from '../../test-utils';
import { DETAILS, FIXES } from './fixes';

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

  describe('without Docker, on the WASI engine (core §4.5)', () => {
    const LINE = 'Codemm can run practice on this computer without Docker, for programs that read input and print output. For everything else, install Docker.';

    it('says practice runs here without Docker and offers Continue, with installing Docker still an option', async () => {
      const user = open({ docker: 'missing', platform: 'mac', wasi: true });
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      // Docker reads as optional, not as a step to take: Continue is the one primary action.
      const installed = screen.getByRole('listitem', { name: 'Docker is installed' });
      expect(within(installed).getByText('Optional')).toBeInTheDocument();
      expect(within(installed).queryByText('Needs a step')).not.toBeInTheDocument();
      expect(within(installed).getByRole('button', { name: 'Install Docker' })).toHaveClass('ghost');
      expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('primary');
      expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
    });

    it('says it too when Docker is installed but stopped', async () => {
      open({ docker: 'stopped', platform: 'windows', wasi: true });
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open Docker Desktop' })).toHaveClass('ghost');
    });

    it('stays on the screen from Connect, so the learner reads it once before going on', async () => {
      renderApp({ to: 'computer', then: { to: 'goal' }, fromConnect: true }, createMock({ docker: 'missing', platform: 'mac', wasi: true }));
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
    });

    it('is the usual Docker screen once Docker is ready', async () => {
      const options: MockOptions = { docker: 'stopped', platform: 'mac', wasi: true };
      open(options);
      await screen.findByText(LINE);
      options.docker = 'ready';
      window.dispatchEvent(new Event('focus'));
      expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
      expect(screen.getByText('Codemm runs your code in Docker, on this computer.')).toBeInTheDocument();
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
    });
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
    // Said once: the row's title and Emm's fill with its text, with no state word beside it and no footer under it.
    expect(within(installed).queryByText('Installing')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^$/);
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

  it('on an older Windows, says why and opens Windows Update; Windows Server gets no such step', async () => {
    const api = createMock({ docker: 'missing', platform: 'windows' });
    const computer = api.computer;
    let problem: 'windows-version' | 'windows-server' = 'windows-version';
    api.computer = async () => ({ ...(await computer()), install: { phase: 'failed', problem } });
    let opened = 0;
    api.openWindowsUpdate = async () => void opened++;
    const user = userEvent.setup();
    renderApp({ to: 'computer', then: welcome }, api);
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    expect(await within(installed).findByRole('alert')).toHaveTextContent(
      'Docker Desktop needs Windows 10 22H2, or Windows 11 23H2 or later. Docker no longer supports older versions, so update Windows first.',
    );
    expect(within(installed).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await user.click(within(installed).getByRole('button', { name: 'Open Windows Update' }));
    expect(opened).toBe(1);
    problem = 'windows-server';
    expect(await within(installed).findByText("Docker Desktop doesn't run on Windows Server.")).toBeInTheDocument();
    expect(within(installed).queryByRole('button', { name: 'Open Windows Update' })).not.toBeInTheDocument();
    expect(within(installed).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
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

  it('is still checking the sandbox just after Docker starts, not asking for a restart', async () => {
    open(scenario('sandbox-checking'));
    const sandbox = await screen.findByRole('listitem', { name: 'The sandbox works' });
    expect(sandbox).toHaveTextContent('Still checking. This can take a minute after Docker starts.');
    expect(sandbox).not.toHaveTextContent('Restart Docker');
    expect(screen.getByRole('status')).toHaveTextContent('Docker just started. Checking again every few seconds.');
  });

  it('gives Linux the start and docker group steps', async () => {
    open({ docker: 'stopped', platform: 'linux' });
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(running).toHaveTextContent('sudo systemctl start docker');
    expect(running).toHaveTextContent('sudo usermod -aG docker $USER');
  });

  it("says what the sandbox's self-test found, instead of Restart Docker, when it knows the cause", async () => {
    open({ docker: 'sandbox-offline', platform: 'mac' });
    const sandbox = await screen.findByRole('listitem', { name: 'The sandbox works' });
    expect(sandbox).toHaveTextContent("Docker couldn't reach the network to download the test image");
    expect(sandbox).not.toHaveTextContent('Restart Docker');
    expect(screen.getByRole('status')).toHaveTextContent("You're offline.");
  });

  it('names the folder to share when the engine cannot mount it', async () => {
    open({ docker: 'sandbox-folder', platform: 'mac' });
    const sandbox = await screen.findByRole('listitem', { name: 'The sandbox works' });
    expect(sandbox).toHaveTextContent('share it with the engine');
    expect(sandbox).not.toHaveTextContent('Restart Docker');
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

  it("on Windows, sets up WSL when that's what Docker's engine needs, then offers Windows' restart", async () => {
    const api = createMock(scenario('wsl-missing'));
    let restarts = 0;
    let installs = 0;
    api.restartWindows = async () => void restarts++;
    const installDocker = api.installDocker;
    api.installDocker = async () => (installs++, installDocker());
    const user = userEvent.setup();
    renderApp({ to: 'computer', then: welcome }, api);
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    // The real cause, not "Docker is starting" or Open Docker Desktop.
    expect(running).toHaveTextContent("Docker needs WSL, Windows' own Linux support. Set it up, then restart Windows.");
    expect(within(running).queryByRole('button', { name: 'Open Docker Desktop' })).not.toBeInTheDocument();
    expect(within(running).getByRole('link', { name: "Microsoft's steps" })).toHaveAttribute('href', 'https://learn.microsoft.com/windows/wsl/install');
    // WSL is Windows' own: no Docker terms line here.
    expect(within(running).queryByText("Docker's terms apply.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Docker needs WSL. Checking again every few seconds.'));
    // Nothing restarts or asks for permission before the learner clicks.
    expect([installs, restarts]).toEqual([0, 0]);
    await user.click(within(running).getByRole('button', { name: 'Set up WSL' }));
    expect(await within(running).findByText('Restart Windows to finish setting up Docker. Save your work in other apps first.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Windows needs a restart.');
    expect([installs, restarts]).toEqual([1, 0]);
    await user.click(within(running).getByRole('button', { name: 'Restart now' }));
    expect([installs, restarts]).toEqual([1, 1]);
  });

  it("shows WSL's setup on the running row while Windows asks for permission", async () => {
    const api = createMock(scenario('wsl-missing'));
    const computer = api.computer;
    api.computer = async () => ({ ...(await computer()), install: { phase: 'wsl' } });
    renderApp({ to: 'computer', then: welcome }, api);
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(await within(running).findByRole('progressbar', { name: 'Allow WSL, which Docker needs, when Windows asks (look in the taskbar).' })).toBeInTheDocument();
    expect(within(running).queryByRole('button')).not.toBeInTheDocument();
  });

  it("keeps a stop of Docker's own install off the WSL row", async () => {
    const api = createMock(scenario('wsl-missing'));
    const computer = api.computer;
    api.computer = async () => ({ ...(await computer()), install: { phase: 'failed', problem: 'unverified' } });
    renderApp({ to: 'computer', then: welcome }, api);
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(await within(running).findByRole('button', { name: 'Set up WSL' })).toBeInTheDocument();
    expect(running).toHaveTextContent("Docker needs WSL, Windows' own Linux support.");
    expect(within(running).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('on Windows, updates an old WSL, then waits while Docker starts', async () => {
    const user = open({ docker: 'wsl-old', platform: 'windows' });
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(running).toHaveTextContent('Docker needs a newer WSL. Update it, then check again.');
    await user.click(within(running).getByRole('button', { name: 'Update WSL' }));
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
  });

  it('on Windows, says to turn on virtualization in the firmware, which only the learner can do', async () => {
    open(scenario('virtualization-off'));
    const running = await screen.findByRole('listitem', { name: 'Docker is running' });
    expect(running).toHaveTextContent("Turn on virtualization in this PC's BIOS or UEFI settings, then start Windows again.");
    expect(within(running).queryAllByRole('button')).toEqual([]);
    expect(within(running).getByRole('link', { name: 'How to turn it on' })).toHaveAttribute('href', expect.stringMatching(/^https:\/\/support\.microsoft\.com\//));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Virtualization is off on this PC. Checking again every few seconds.'));
  });

  it('offers Restart now when an install needs a restart, and says when WSL needed permission or failed', async () => {
    const api = createMock({ docker: 'missing', platform: 'windows' });
    const computer = api.computer;
    let problem: 'restart' | 'declined' | 'wsl-failed' = 'restart';
    api.computer = async () => ({ ...(await computer()), install: { phase: 'failed', problem } });
    let restarts = 0;
    api.restartWindows = async () => void restarts++;
    const user = userEvent.setup();
    renderApp({ to: 'computer', then: welcome }, api);
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    await user.click(await within(installed).findByRole('button', { name: 'Restart now' }));
    expect(restarts).toBe(1);
    problem = 'declined';
    expect(await within(installed).findByText('Windows asks for permission first. Try again, and choose Yes.')).toBeInTheDocument();
    expect(within(installed).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(installed).queryByRole('button', { name: 'Restart now' })).not.toBeInTheDocument();
    problem = 'wsl-failed';
    expect(await within(installed).findByText("WSL's setup didn't finish.")).toBeInTheDocument();
    expect(within(installed).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('only links to official pages, and has a fix for every check on every platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      for (const id of ['docker-installed', 'docker-running', 'sandbox'] as const) {
        const fix = FIXES[platform][id];
        expect(fix?.steps.length).toBeGreaterThan(0);
        if (fix?.link) expect(isSafeLink(fix.link.url)).toBe(true);
      }
    }
    for (const { fix } of Object.values(DETAILS)) if (fix.link) expect(isSafeLink(fix.link.url)).toBe(true);
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

describe('a look that fails after one worked', () => {
  it('keeps the checks on screen when a later check fails, says so, and Try again checks again', async () => {
    const user = userEvent.setup();
    const api = createMock({ docker: 'missing', platform: 'mac' });
    const computer = api.computer.bind(api);
    let failing = false;
    api.computer = () => (failing ? Promise.reject(new Error('codemm:offline')) : computer());
    renderApp({ to: 'computer', then: welcome }, api);
    expect(await screen.findByRole('listitem', { name: 'Docker is installed' })).toBeInTheDocument();
    failing = true;
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/Codemm couldn't refresh this/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('listitem', { name: 'Docker is installed' })).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Codemm couldn't refresh this/)).not.toBeInTheDocument());
  });
});
