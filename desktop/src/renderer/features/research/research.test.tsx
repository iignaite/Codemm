import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobProgress, JobStep } from '../../../shared/api';
import { createMock } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('research progress', () => {
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
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
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
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
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
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    expect(await screen.findByText('Searching react hooks')).toBeInTheDocument();
    expect(screen.getByText('4 steps')).toBeInTheDocument();
    act(() => hear({ job: 'j2', kind: 'tutor', stage: 0, steps: [{ kind: 'step', label: 'Reading the lesson' }], count: 1, thinking: true, elapsedMs: 0, idleMs: 0 }));
    expect(screen.queryByText('Reading the lesson')).not.toBeInTheDocument();
  });
});
