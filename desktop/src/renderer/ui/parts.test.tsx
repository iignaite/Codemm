import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner';
import { Busy } from './Busy';
import { Status } from './Icon';
import { ExternalLink } from './ExternalLink';
import { Panel } from './Panel';
import { RunButton } from './RunButton';

describe('Status', () => {
  it('is an image named for its state when it stands alone', () => {
    render(<Status kind="ok" />);
    expect(screen.getByRole('img', { name: 'Passed' })).toBeInTheDocument();
  });

  it('is hidden from screen readers when the words beside it say the same', () => {
    const { container } = render(<span><Status kind="ok" decorative />Connected</span>);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.ico')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.ico')).not.toHaveAttribute('aria-label');
  });
});

describe('shared parts', () => {
  it('Busy: the running status beside its text', () => {
    render(<Busy>Checking</Busy>);
    expect(screen.getByText('Checking')).toHaveClass('busy');
    // The words say it: the icon isn't read too ("In progress, Checking").
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Checking').querySelector('.ico')).toHaveAttribute('aria-hidden', 'true');
  });

  it('Panel: an alert with art, a heading at the asked level, text and actions', () => {
    render(<Panel art={<span>art</span>} title="Docker stopped." level={2} text="Start Docker, then try again."><button type="button">Try again</button></Panel>);
    const panel = screen.getByRole('alert');
    expect(panel).toHaveClass('card', 'panel');
    expect(screen.getByRole('heading', { level: 2, name: 'Docker stopped.' })).toBeInTheDocument();
    expect(screen.getByText('Start Docker, then try again.')).toHaveClass('sub');
    expect(screen.getByRole('button', { name: 'Try again' }).parentElement).toHaveClass('actions');
  });

  it('Banner: an info card, spread out when it has an action', () => {
    const { rerender } = render(<Banner action={<button type="button">Resume roadmap</button>}>React</Banner>);
    expect(screen.getByText('React').parentElement).toHaveClass('card', 'info', 'resume');
    rerender(<Banner>Codemm will set it up.</Banner>);
    expect(screen.getByText('Codemm will set it up.').parentElement).not.toHaveClass('resume');
  });

  it('ExternalLink: opens outside the app, sending no referrer', () => {
    render(<ExternalLink href="https://react.dev/learn">React docs</ExternalLink>);
    const a = screen.getByRole('link', { name: 'React docs' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noreferrer');
  });

  it('RunButton: one button that turns into Stop, so focus stays on it', async () => {
    const run = vi.fn();
    const stop = vi.fn();
    const { rerender } = render(<RunButton running={false} onRun={run} onStop={stop} />);
    const before = screen.getByRole('button', { name: 'Run' });
    await userEvent.click(before);
    expect(run).toHaveBeenCalled();
    expect(before).toHaveFocus();
    rerender(<RunButton running onRun={run} onStop={stop} disabled />);
    const button = screen.getByRole('button', { name: 'Stop' });
    // The same element, still focused: Stop is never disabled.
    expect(button).toBe(before);
    expect(button).toHaveFocus();
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(stop).toHaveBeenCalled();
    // While Try it or Check runs, Run is disabled and starts nothing.
    run.mockClear();
    rerender(<RunButton running={false} onRun={run} onStop={stop} disabled />);
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(run).not.toHaveBeenCalled();
  });
});
