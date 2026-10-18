import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobProgress } from '../../shared/api';
import { JobBar, QUIET_MS } from './JobBar';

const job = (over: Partial<JobProgress> = {}): JobProgress => ({ job: 'j1', kind: 'lesson', stage: 1, steps: [], count: 0, thinking: true, elapsedMs: 0, idleMs: 0, ...over });
const show = (p: JobProgress, props: { compact?: boolean } = {}) => render(<JobBar job={{ progress: p, at: Date.now() }} label="Writing the lesson" {...props} />);

afterEach(() => vi.useRealTimers());

describe('JobBar (§4.11)', () => {
  it('lights each stage once reached, and marks the current one', () => {
    show(job({ stage: 1 }));
    const stages = within(screen.getByRole('group', { name: 'Writing the lesson' })).getAllByRole('listitem');
    expect(stages.map((s) => [s.textContent, s.className, s.getAttribute('aria-current')])).toEqual([
      ['Starting', 'done', null],
      ['Writing the lesson', 'now', 'step'],
      ['Saving the lesson', '', null],
    ]);
  });

  it("shows the latest step, or a retry, and never a percentage", () => {
    const { rerender } = show(job({ steps: [{ kind: 'step', label: 'Reading the roadmap' }] }));
    expect(screen.getByText('Reading the roadmap')).toBeInTheDocument();
    rerender(<JobBar job={{ progress: job({ retry: { attempt: 2, of: 3 } }), at: Date.now() }} label="Writing the lesson" />);
    expect(screen.getByText('Trying again (2 of 3)')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('counts the time so far, from where the job was when it arrived', () => {
    vi.useFakeTimers();
    show(job({ elapsedMs: 65_000 }));
    expect(screen.getByRole('timer', { name: 'Time so far' })).toHaveTextContent('1:05');
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('timer')).toHaveTextContent('1:15');
  });

  it('says it is still working after 90 seconds with no event while the agent thinks', () => {
    vi.useFakeTimers();
    show(job({ idleMs: QUIET_MS - 5000 }));
    expect(screen.queryByText('Still working: the agent is thinking.')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('Still working: the agent is thinking.')).toBeInTheDocument();
  });

  it("stays quiet while Codemm itself works, such as a build", () => {
    show(job({ kind: 'setup', stage: 1, thinking: false, idleMs: QUIET_MS * 2 }));
    expect(screen.queryByText('Still working: the agent is thinking.')).not.toBeInTheDocument();
  });

  it('compact: names only the current stage, and a retry but not the latest step', () => {
    const { rerender } = show(job({ stage: 1, steps: [{ kind: 'step', label: 'Reading the roadmap' }] }), { compact: true });
    expect(screen.getByText('Writing the lesson', { selector: '.job-now span' })).toBeInTheDocument();
    expect(screen.getByText('Starting')).toHaveClass('sr-only');
    expect(screen.queryByText('Reading the roadmap')).not.toBeInTheDocument();
    rerender(<JobBar job={{ progress: job({ stage: 1, retry: { attempt: 2, of: 3 } }), at: Date.now() }} label="Writing the lesson" compact />);
    expect(screen.getByText('Trying again (2 of 3)')).toBeInTheDocument();
  });
});
