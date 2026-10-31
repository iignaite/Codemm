import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock, type MockOptions } from '../../../main/mock';
import { mockWithCourse, mockWithRoadmap, renderApp } from '../../test-utils';

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
    await waitFor(() => expect(asked[0]).toEqual({ topic: 'React', known: '', depth: 'in-depth', practice: 'code' }));
  });
});

describe('a goal not set up yet', () => {
  it('says so only for the goal the learner settled on, not for each half-typed word', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    renderApp({ to: 'goal' }, api);
    await user.type(await screen.findByRole('textbox', { name: 'What do you want to learn?' }), 'Data s');
    expect(screen.queryByText(/isn't set up yet/)).not.toBeInTheDocument();
    expect(await screen.findByText("Data s isn't set up yet.", undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('says nothing for a set-up track typed with punctuation', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    api.tracks = async () => [{ ref: 'react@1', name: 'React' }];
    renderApp({ to: 'goal' }, api);
    await user.type(await screen.findByRole('textbox', { name: 'What do you want to learn?' }), 'react?');
    await new Promise((r) => setTimeout(r, 800));
    expect(screen.queryByText(/isn't set up yet/)).not.toBeInTheDocument();
  });

  it('names the goal tidily, not with the punctuation typed', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    renderApp({ to: 'goal' }, api);
    await user.type(await screen.findByRole('textbox', { name: 'What do you want to learn?' }), 'springboot?');
    expect(await screen.findByText("Springboot isn't set up yet.", undefined, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe('fields with a limit', () => {
  it('keeps the goal and what the learner knows within their limits, and says so, so research never gets bad input', async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    const asked: { topic: string; known: string }[] = [];
    const research = api.research;
    api.research = (goal) => (asked.push(goal), research(goal));
    renderApp({ to: 'goal' }, api);
    const goal = await screen.findByRole('textbox', { name: 'What do you want to learn?' });
    await user.click(goal);
    await user.paste('a'.repeat(250));
    expect(goal).toHaveValue('a'.repeat(200));
    expect(screen.getByText('Up to 200 characters.')).toBeInTheDocument();
    await user.click(screen.getByRole('textbox', { name: 'What you already know (optional)' }));
    await user.paste('b'.repeat(600));
    expect(screen.getByText('Up to 500 characters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(asked[0]).toMatchObject({ topic: 'a'.repeat(200), known: 'b'.repeat(500) }));
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
    expect(await screen.findByText("React isn't set up yet.", undefined, { timeout: 2000 })).toBeInTheDocument();

    const known = screen.getByRole('textbox', { name: 'What you already know (optional)' });
    expect(known).toHaveAttribute('placeholder', 'What you already know (optional)');
    await user.type(known, 'Python');

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
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('Sign in to Claude Code, then try again.');
  });

  it('says when research hits the plan limit', async () => {
    const api = createMock({ agentProblem: 'plan-limit' });
    await api.connect('claude');
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    expect(await screen.findByText("Your agent's plan limit is reached. Try again later.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't reach Codemm.")).not.toBeInTheDocument();
  });

  it('says when research found the computer offline, with no Check your agent', async () => {
    const api = createMock({ agentProblem: 'offline' });
    await api.connect('claude');
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
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
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm couldn't finish the research.");
    expect(within(alert).getByRole('button', { name: 'Check your agent' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('goes to connect when no agent is connected', async () => {
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } });
    expect(await screen.findByRole('heading', { name: 'Connect an agent' })).toBeInTheDocument();
  });

  it('does not start without a goal', async () => {
    renderApp({ to: 'goal' });
    expect(await screen.findByRole('button', { name: 'Start' })).toBeDisabled();
  });
});

describe('resuming a roadmap', () => {
  it('offers the roadmap that is not approved yet, and opens it with its edits', async () => {
    const user = userEvent.setup();
    const { api, roadmap } = await mockWithRoadmap();
    await api.saveDraft([...roadmap.concepts.slice(0, -2), ...roadmap.concepts.slice(-2).reverse()]);
    renderApp({ to: 'goal' }, api);
    await user.click(await screen.findByRole('button', { name: 'Resume roadmap' }));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    const topics = within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));
    expect(topics.slice(-2)).toEqual(['Forms', 'Lists and keys']);
  });

  it('offers nothing to resume once the roadmap is approved', async () => {
    const { api } = await mockWithCourse();
    renderApp({ to: 'goal' }, api);
    await screen.findByRole('textbox', { name: 'What do you want to learn?' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Resume roadmap' })).not.toBeInTheDocument();
  });
});

it('sends Lessons only with the goal', async () => {
  const user = userEvent.setup();
  const api = createMock();
  await api.connect('claude');
  const asked: unknown[] = [];
  const research = api.research;
  api.research = (goal) => (asked.push(goal), research(goal));
  renderApp({ to: 'goal' }, api);
  await user.click(await screen.findByRole('radio', { name: 'Lessons only' }));
  await user.type(screen.getByRole('textbox', { name: 'What do you want to learn?' }), 'History{Enter}');
  await waitFor(() => expect(asked[0]).toEqual({ topic: 'History', known: '', depth: 'standard', practice: 'none' }));
});

it('offers Quiz and carries the choice to research', async () => {
  const asked: unknown[] = [];
  const { api } = await mockWithCourse();
  api.research = async (goal) => { asked.push(goal); return { state: 'running' }; };
  renderApp({ to: 'goal' }, api);
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'What do you want to learn?' }), 'Judgment');
  await user.click(screen.getByRole('radio', { name: 'Quiz' }));
  await user.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(asked[0]).toMatchObject({ practice: 'quiz' }));
  expect(screen.queryByText(/isn't set up yet/)).not.toBeInTheDocument();
});
