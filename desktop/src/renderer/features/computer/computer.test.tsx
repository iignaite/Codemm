import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, type MockOptions } from '../../../main/mock';
import { isOfficialLink } from '../../../main/links';
import { mockWithCourse, renderApp } from '../../test-utils';
import { FIXES } from './fixes';

const welcome = { to: 'welcome' } as const;

function open(options: MockOptions) {
  const user = userEvent.setup();
  renderApp({ to: 'computer', then: welcome }, createMock(options));
  return user;
}

describe('check this computer', () => {
  it('follows connecting an agent, and says when the computer is ready', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'connect' });
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Connect' }));
    await within(claude).findByText('Connected');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
    expect(await screen.findByText('This computer is ready.')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Docker is installed' })).getByText('Ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Ready when you are.' })).toBeInTheDocument();
  });

  it('shows the fix for this computer, links to the official page, and re-checks until Docker is ready', async () => {
    const options: MockOptions = { docker: 'missing', platform: 'windows' };
    const user = open(options);
    const installed = await screen.findByRole('listitem', { name: 'Docker is installed' });
    expect(within(installed).getByText('Needs a step')).toBeInTheDocument();
    expect(installed).toHaveTextContent('WSL 2');
    const link = within(installed).getByRole('link', { name: 'Get Docker Desktop' });
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
    const link = await screen.findByRole('link', { name: 'Get Docker Desktop' });
    expect(screen.getByRole('status')).toHaveTextContent("Docker isn't installed yet. Checking again every few seconds.");
    link.focus();
    options.docker = 'stopped';
    expect(await screen.findByText("Docker isn't running yet. Checking again every few seconds.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toHaveFocus();
  });

  it('gives Linux the docker group step', async () => {
    open({ docker: 'no-access', platform: 'linux' });
    const access = await screen.findByRole('listitem', { name: 'Codemm can use Docker' });
    expect(access).toHaveTextContent('sudo usermod -aG docker $USER');
  });

  it('lets the learner carry on later', async () => {
    const user = open({ docker: 'stopped', platform: 'mac' });
    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(await screen.findByRole('heading', { name: 'Learn anything.' })).toBeInTheDocument();
  });

  it('opens from a check that was not counted, then goes back to the activity', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true, docker: 'stopped' });
    renderApp({ to: 'practice', activityId: course.topics[0].activity.id }, api);
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    const results = screen.getByRole('region', { name: 'Results' });
    await user.click(await within(results).findByRole('button', { name: 'Check this computer' }));
    expect(await screen.findByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('only links to official pages, and has a fix for every check on every platform', () => {
    for (const platform of ['mac', 'windows', 'linux'] as const) {
      for (const id of ['docker-installed', 'docker-running', 'docker-access'] as const) {
        if (platform !== 'linux' && id === 'docker-access') continue;
        const fix = FIXES[platform][id];
        expect(fix?.steps.length).toBeGreaterThan(0);
        if (fix?.link) expect(isOfficialLink(fix.link.url)).toBe(true);
      }
    }
  });
});
