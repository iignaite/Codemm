import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockWithCourse, renderApp } from '../../test-utils';

describe('tracks', () => {
  it('lists what Codemm has set up, rebuilds a track, and starts something new', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    expect(await within(react).findByRole('button', { name: 'Rebuild' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Rust' }));
    expect(screen.getByRole('textbox', { name: 'Learn something new' })).toHaveValue('Rust');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Researching Rust' })).toBeInTheDocument();
  });
});
