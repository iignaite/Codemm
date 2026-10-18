import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageFill } from './StageFill';

describe('StageFill (installs)', () => {
  it('fills Emm one share per stage reached, the download filling its own share', () => {
    const { rerender } = render(<StageFill label="Downloading Docker Desktop" stages={4} stage={0} part={0.6} text="Downloading Docker Desktop 60%" />);
    const bar = screen.getByRole('progressbar', { name: 'Downloading Docker Desktop' });
    // Stage 0 of 4 reached, plus 0.6 of its share: (1 + 0.6) / 5.
    expect(bar).toHaveAttribute('aria-valuenow', '32');
    expect(bar).toHaveAttribute('aria-valuetext', 'Downloading Docker Desktop 60%');
    expect(screen.getByText('Downloading Docker Desktop 60%')).toBeInTheDocument();
    rerender(<StageFill label="Checking it's from Docker" stages={4} stage={1} text="Checking it's from Docker…" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  it('shows Emm as decoration, and no elapsed time: an install has no start Codemm knows', () => {
    const { container } = render(<StageFill label="Installing" stages={3} stage={2} text="Installing Codex…" />);
    expect(container.querySelector('.emm-fill')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.job-time')).toBeNull();
  });
});
