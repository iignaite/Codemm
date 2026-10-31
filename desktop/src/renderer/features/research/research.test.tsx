import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AGENT_FAILED, OFFLINE, type JobProgress, type JobStep } from '../../../shared/api';
import { createMock } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('research progress', () => {
  it('names the goal tidily, not with the punctuation typed', async () => {
    const api = createMock();
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: ' springboot? ', known: '', depth: 'standard', practice: 'code' } }, api);
    expect(await screen.findByRole('heading', { name: 'Researching Springboot' })).toBeInTheDocument();
  });

  it('shows the review on the research screen while the roadmap waits', async () => {
    const api = createMock();
    let hear: (p: JobProgress) => void = () => undefined;
    api.onJobProgress = (listener) => ((hear = listener), () => undefined);
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: 'Systems', known: '', depth: 'standard', practice: 'code' } }, api);
    await screen.findByRole('heading', { name: 'Researching Systems' });
    act(() => hear({ job: 'review-1', kind: 'review', stage: 1, steps: [], count: 0, thinking: true, elapsedMs: 0, idleMs: 0 }));
    expect(screen.getByText('Reviewing the roadmap')).toBeInTheDocument();
  });

  it('lists what research is looking at, the latest first, with a step count', async () => {
    const api = createMock();
    let hear: (p: JobProgress) => void = () => undefined;
    api.onJobProgress = (listener) => ((hear = listener), () => undefined);
    const steps: JobStep[] = [];
    const tell = (step: JobStep) => {
      steps.unshift(step);
      hear({ job: 'j1', kind: 'research', stage: 1, steps: [...steps], count: steps.length, thinking: true, elapsedMs: 0, idleMs: 0 });
    };
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    await screen.findByRole('heading', { name: 'Researching React' });
    act(() => tell({ kind: 'search', query: 'react roadmap 2026' }));
    act(() => tell({ kind: 'read', url: 'roadmap.sh/react' }));
    act(() => tell({ kind: 'step', label: 'Saving the roadmap' }));
    const list = screen.getByRole('list', { name: 'What Codemm is looking at' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Saving the roadmap', 'Reading roadmap.sh/react', 'Searching react roadmap 2026']);
    expect(screen.getByText('3 steps')).toBeInTheDocument();
    // Older steps stay readable (WCAG AA): no row is faded; the latest one stands out by its color instead.
    const rows = within(list).getAllByRole('listitem');
    for (const li of rows) expect(li.style.opacity).toBe('');
    expect(rows.map((li) => li.classList.contains('now'))).toEqual([true, false, false]);
  });

  it('never brings back a job that ended while its first read was on the way', async () => {
    const api = createMock();
    let hear: (p: JobProgress) => void = () => undefined;
    api.onJobProgress = (listener) => ((hear = listener), () => undefined);
    let answer: (ps: JobProgress[]) => void = () => undefined;
    api.jobProgress = () => new Promise((r) => (answer = r));
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    await screen.findByRole('heading', { name: 'Researching React' });
    const job: JobProgress = { job: 'j1', kind: 'research', stage: 1, steps: [{ kind: 'search', query: 'react hooks' }], count: 1, thinking: true, elapsedMs: 0, idleMs: 0 };
    act(() => hear({ ...job, ended: true }));
    await act(async () => answer([job]));
    expect(screen.queryByText('Searching react hooks')).not.toBeInTheDocument();
  });

  it('opened while research runs, shows its steps so far, and ignores other jobs', async () => {
    const api = createMock();
    let hear: (p: JobProgress) => void = () => undefined;
    api.onJobProgress = (listener) => ((hear = listener), () => undefined);
    api.jobProgress = async () => [{ job: 'j1', kind: 'research', stage: 1, steps: [{ kind: 'search', query: 'react hooks' }], count: 4, thinking: true, elapsedMs: 9000, idleMs: 0 }];
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard', practice: 'code' } }, api);
    expect(await screen.findByText('Searching react hooks')).toBeInTheDocument();
    expect(screen.getByText('4 steps')).toBeInTheDocument();
    act(() => hear({ job: 'j2', kind: 'tutor', stage: 0, steps: [{ kind: 'step', label: 'Reading the lesson' }], count: 1, thinking: true, elapsedMs: 0, idleMs: 0 }));
    expect(screen.queryByText('Reading the lesson')).not.toBeInTheDocument();
  });
});

describe('research that fails', () => {
  const goal = { topic: 'React', known: '', depth: 'standard' as const, practice: 'code' as const };

  it('says research could not finish, and why, when its read fails while it runs: not a failed refresh', async () => {
    const api = createMock();
    let failing = false;
    api.research = async () => {
      if (failing) throw new Error(OFFLINE);
      return { state: 'running' };
    };
    renderApp({ to: 'research', goal }, api);
    await screen.findByRole('heading', { name: 'Researching React' });
    failing = true;
    const panel = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(within(panel).getByRole('heading', { name: "Codemm couldn't finish the research." })).toBeInTheDocument();
    expect(panel).toHaveTextContent("You're offline. Connect to the internet, then try again.");
    // Offline isn't the agent's doing, so there's no Check your agent (#68).
    expect(within(panel).queryByRole('button', { name: 'Check your agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Suggested path' })).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't refresh/)).not.toBeInTheDocument();
    // Back online, Try again reads again and research carries on.
    failing = false;
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Researching React' })).toBeInTheDocument();
  });

  it("offers Check your agent when the agent's job stopped", async () => {
    const api = createMock();
    let failing = false;
    api.research = async () => {
      if (failing) throw new Error(AGENT_FAILED);
      return { state: 'running' };
    };
    renderApp({ to: 'research', goal }, api);
    await screen.findByRole('heading', { name: 'Researching React' });
    failing = true;
    const panel = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Check your agent', 'Try again']);
  });

  it('says the same when the very first read fails', async () => {
    const api = createMock();
    api.research = async () => {
      throw new Error(OFFLINE);
    };
    renderApp({ to: 'research', goal }, api);
    const panel = await screen.findByRole('alert');
    expect(within(panel).getByRole('heading', { name: "Codemm couldn't finish the research." })).toBeInTheDocument();
    expect(panel).toHaveTextContent("You're offline.");
  });
});
