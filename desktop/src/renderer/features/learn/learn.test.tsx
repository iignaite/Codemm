import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, type MockOptions } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('choose journey', () => {
  it('takes a goal and what the learner knows, researches, then opens the course editor', async () => {
    const user = userEvent.setup();
    renderApp({ to: 'goal' });
    const goal = await screen.findByRole('textbox', { name: 'What do you want to learn?' });
    await user.type(goal, 'React');
    expect(await screen.findByText("React isn't set up yet.")).toBeInTheDocument();

    const known = screen.getByRole('group', { name: 'I already know' });
    const python = within(known).getByRole('button', { name: 'Python' });
    await user.click(python);
    expect(python).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(known).getByRole('button', { name: 'Nothing yet' }));
    expect(python).toHaveAttribute('aria-pressed', 'false');
    await user.click(python);

    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Researching React' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Suggested path' })).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'React basics' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(3);
  });

  it('sends the learner to sign in when research needs it', async () => {
    const options: MockOptions = {};
    const api = createMock(options);
    await api.connect('claude');
    options.agentProblem = 'signed-out';
    renderApp({ to: 'research', goal: { topic: 'React', known: [] } }, api);
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('Sign in to Claude Code, then try again.');
  });

  it('says when research hits the plan limit', async () => {
    renderApp({ to: 'research', goal: { topic: 'React', known: [] } }, createMock({ agentProblem: 'plan-limit' }));
    expect(await screen.findByText("Your agent's plan limit is reached. Try again later.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't reach Codemm.")).not.toBeInTheDocument();
  });

  it('does not start without a goal', async () => {
    renderApp({ to: 'goal' });
    expect(await screen.findByRole('button', { name: 'Start' })).toBeDisabled();
  });
});
