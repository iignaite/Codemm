import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWith } from '../../test/render';
import { Goal } from './Goal';

describe('Goal', () => {
  it('takes any topic and what the learner already knows', async () => {
    const { user, go } = renderWith(<Goal />);
    const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'What do you want to learn?' }), 'React');
    const python = await screen.findByRole('button', { name: 'Python' });
    await user.click(python);
    expect(python.getAttribute('aria-pressed')).toBe('true');
    await user.click(start);
    expect(go).toHaveBeenCalledWith({ to: 'research', goal: { topic: 'React', known: ['Python'] } });
  });

  it('"Nothing yet" clears what was picked', async () => {
    const { user } = renderWith(<Goal />);
    const python = await screen.findByRole('button', { name: 'Python' });
    await user.click(python);
    const nothing = screen.getByRole('button', { name: 'Nothing yet' });
    await user.click(nothing);
    expect(python.getAttribute('aria-pressed')).toBe('false');
    expect(nothing.getAttribute('aria-pressed')).toBe('true');
  });

  it('says when a topic is not set up yet', async () => {
    const { user } = renderWith(<Goal />);
    const field = screen.getByRole('textbox', { name: 'What do you want to learn?' });
    await user.type(field, 'React');
    expect(await screen.findByText("React isn't set up yet.")).toBeTruthy();
    await user.clear(field);
    await user.type(field, 'java');
    expect(screen.queryByText(/isn't set up yet/)).toBeNull();
  });
});
