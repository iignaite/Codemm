import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWith } from '../../test/render';
import { Tracks } from './Tracks';

describe('Tracks', () => {
  it('lists what Codemm has set up, with a rebuild for each', async () => {
    const { user, api } = renderWith(<Tracks />);
    const rebuild = vi.spyOn(api, 'rebuildTrack');
    await user.click(await screen.findByRole('button', { name: 'Rebuild Java' }));
    expect(rebuild).toHaveBeenCalledWith('java');
    expect(screen.getByRole('button', { name: 'Rebuild C' })).toBeTruthy();
  });

  it('starts something new from a suggestion', async () => {
    const { user, go } = renderWith(<Tracks />);
    await user.click(await screen.findByRole('button', { name: 'Rust' }));
    expect((screen.getByRole('textbox', { name: 'Learn something new' }) as HTMLInputElement).value).toBe('Rust');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(go).toHaveBeenCalledWith({ to: 'research', goal: { topic: 'Rust', known: [] } });
  });
});
