import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, type MockOptions } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('how deep the roadmap goes', () => {
  it('offers three depths, Standard first, and researches at the one chosen', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    const asked: unknown[] = [];
    const research = api.research;
    api.research = (goal) => (asked.push(goal), research(goal));
    renderApp({ to: 'goal' }, api);
    const depth = await screen.findByRole('radiogroup', { name: 'How deep' });
    expect(within(depth).getAllByRole('radio').map((r) => r.getAttribute('aria-label') ?? (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Overview', 'Standard', 'In depth']);
    expect(within(depth).getByRole('radio', { name: 'Standard' })).toBeChecked();
    await user.click(within(depth).getByRole('radio', { name: 'In depth' }));
    await user.type(screen.getByRole('textbox', { name: 'What do you want to learn?' }), 'React{Enter}');
    await waitFor(() => expect(asked[0]).toEqual({ topic: 'React', known: '', depth: 'in-depth' }));
  });
});

describe('choose journey', () => {
  it('takes a goal and what the learner knows, researches, then opens the course editor', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    renderApp({ to: 'goal' }, api);
    const goal = await screen.findByRole('textbox', { name: 'What do you want to learn?' });
    await user.type(goal, 'React');
    expect(await screen.findByText("React isn't set up yet.")).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'I already know' }), 'Python');

    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Researching React' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Suggested path' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Approve' }, { timeout: 3000 })).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem').length).toBeGreaterThan(3);
  });

  it('sends the learner to sign in when research needs it', async () => {
    const options: MockOptions = {};
    const api = createMock(options);
    await api.connect('claude');
    options.agentProblem = 'signed-out';
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('Sign in to Claude Code, then try again.');
  });

  it('says when research hits the plan limit', async () => {
    const api = createMock({ agentProblem: 'plan-limit' });
    await api.connect('claude');
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    expect(await screen.findByText("Your agent's plan limit is reached. Try again later.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't reach Codemm.")).not.toBeInTheDocument();
  });

  it('says when research found the computer offline, with no Check your agent', async () => {
    const api = createMock({ agentProblem: 'offline' });
    await api.connect('claude');
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("You're offline. Connect to the internet, then try again.");
    expect(within(alert).getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again']);
  });

  it('says when research failed, and tries again', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    const research = api.research;
    let failed = false;
    api.research = (goal) => (failed ? research(goal) : ((failed = true), Promise.resolve({ state: 'failed' as const })));
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm couldn't finish that.");
    expect(within(alert).getByRole('button', { name: 'Check your agent' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('goes to connect when no agent is connected', async () => {
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } });
    expect(await screen.findByRole('heading', { name: 'Connect an agent' })).toBeInTheDocument();
  });

  it('does not start without a goal', async () => {
    renderApp({ to: 'goal' });
    expect(await screen.findByRole('button', { name: 'Start' })).toBeDisabled();
  });
});
