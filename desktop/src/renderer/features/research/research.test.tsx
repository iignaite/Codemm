import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../../main/mock';
import { renderWith } from '../../test/render';
import { Research } from './Research';

describe('Research', () => {
  it('reads sources and suggests a path', async () => {
    const goal = { topic: 'React', known: ['Python'] };
    const { user, go } = renderWith(<Research goal={goal} />);
    expect(screen.getByRole('heading', { name: 'Researching React' })).toBeTruthy();
    const path = screen.getByRole('region', { name: 'Suggested path' });
    expect(await within(path).findByText('JavaScript basics')).toBeTruthy();
    expect(within(path).getByText('You know Python')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Reading' })).getByText('React docs')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(go).toHaveBeenCalledWith({ to: 'draft', draft: expect.objectContaining({ title: 'React basics' }) });
  });

  it('offers to try again when research fails', async () => {
    const api = createMockApi({ delayMs: 0 });
    vi.spyOn(api, 'research').mockRejectedValueOnce(new Error('offline'));
    const { user } = renderWith(<Research goal={{ topic: 'React', known: [] }} />, { api });
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('JavaScript basics')).toBeTruthy();
  });
});
