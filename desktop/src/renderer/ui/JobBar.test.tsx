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
    const time = () => document.querySelector('.job-time')!.textContent;
    expect(time()).toBe('1:05');
    act(() => vi.advanceTimersByTime(10_000));
    expect(time()).toBe('1:15');
  });

  it('is a progressbar: Emm fills to the stages reached, named for screen readers by stage and time', () => {
    vi.useFakeTimers();
    show(job({ stage: 1, elapsedMs: 7000 }));
    const bar = screen.getByRole('progressbar', { name: 'Writing the lesson' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-valuetext', 'Writing the lesson, 0:07');
    expect(bar.querySelector('.emm-fill')).toHaveAttribute('aria-hidden', 'true');
    expect((bar.querySelector('.emm-fill') as HTMLElement).style.getPropertyValue('--fill')).toBe('50%');
  });

  it('dims Emm while it tries again, and says so', () => {
    show(job({ stage: 1, retry: { attempt: 2, of: 3 } }));
    expect(document.querySelector('.emm-fill')).toHaveClass('dim');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Trying again (2 of 3), 0:00');
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

  it('compact: a small Emm and one line, the latest step (or the stage) and the time, with no stage list', () => {
    const { rerender } = show(job({ stage: 1, steps: [{ kind: 'step', label: 'Reading the roadmap' }] }), { compact: true });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(document.querySelector('.job-step')).toHaveTextContent('Reading the roadmap');
    expect(document.querySelector('.job-time')).toHaveTextContent('0:00');
    rerender(<JobBar job={{ progress: job({ stage: 1 }), at: Date.now() }} label="Writing the lesson" compact />);
    expect(document.querySelector('.job-step')).toHaveTextContent('Writing the lesson');
    rerender(<JobBar job={{ progress: job({ stage: 1, retry: { attempt: 2, of: 3 } }), at: Date.now() }} label="Writing the lesson" compact />);
    expect(document.querySelector('.job-step')).toHaveTextContent('Try 2 of 3');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Trying again (2 of 3), 0:00');
  });

});
