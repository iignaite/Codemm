import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMock } from '../../main/mock';
import { renderApp } from '../test-utils';

const sidebar = () => screen.getByRole('navigation', { name: 'Main' });

describe('update notice', () => {
  it('an unsigned build says a new version is out, with a link to its release', async () => {
    const api = createMock({ update: { kind: 'available', version: '1.2.0', url: 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0' } });
    renderApp({ to: 'tracks' }, api);
    expect(await within(sidebar()).findByText('A new version is available.')).toBeInTheDocument();
    const link = within(sidebar()).getByRole('link', { name: 'Get Codemm 1.2.0' });
    expect(link).toHaveAttribute('href', 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('a signed build offers Restart to update once the new version is downloaded', async () => {
    const api = createMock({ update: { kind: 'ready', version: '1.2.0' } });
    const restart = vi.spyOn(api, 'restartToUpdate');
    renderApp({ to: 'tracks' }, api);
    await userEvent.setup().click(await within(sidebar()).findByRole('button', { name: 'Restart to update' }));
    expect(within(sidebar()).getByText('Codemm 1.2.0 is ready.')).toBeInTheDocument();
    expect(restart).toHaveBeenCalled();
  });

  it('says nothing while nothing is new, or while a signed build is still downloading', async () => {
    for (const update of [{ kind: 'none' as const }, { kind: 'downloading' as const, version: '1.2.0' }]) {
      const view = renderApp({ to: 'tracks' }, createMock({ update }));
      await screen.findByRole('heading', { name: /tracks/i });
      expect(within(sidebar()).queryByText(/version|ready/)).not.toBeInTheDocument();
      view.unmount();
    }
  });
});
