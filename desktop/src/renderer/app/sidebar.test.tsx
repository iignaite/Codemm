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
    // The version is in the link, not in the words.
    const link = within(sidebar()).getByRole('link', { name: 'Get it' });
    expect(link).toHaveAttribute('href', 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0');
    expect(link).toHaveAttribute('target', '_blank');
    expect(sidebar()).not.toHaveTextContent('1.2.0');
  });

  it('a signed build offers Restart to update once the new version is downloaded', async () => {
    const api = createMock({ update: { kind: 'ready', version: '1.2.0' } });
    const restart = vi.spyOn(api, 'restartToUpdate');
    renderApp({ to: 'tracks' }, api);
    await userEvent.setup().click(await within(sidebar()).findByRole('button', { name: 'Restart to update' }));
    expect(within(sidebar()).getByText('A new version is ready.')).toBeInTheDocument();
    expect(sidebar()).not.toHaveTextContent('1.2.0');
    expect(restart).toHaveBeenCalled();
  });

  it('shows an update found later, without navigating, and announces it as a status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMock();
      let status: Awaited<ReturnType<typeof api.update>> = { kind: 'none' };
      api.update = async () => status;
      renderApp({ to: 'tracks' }, api);
      const region = await within(sidebar()).findByRole('status', { name: 'Codemm updates' });
      expect(region).toBeEmptyDOMElement();
      status = { kind: 'downloading', version: '1.2.0' };
      await vi.advanceTimersByTimeAsync(31_000);
      status = { kind: 'ready', version: '1.2.0' };
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.waitFor(() => expect(region).toHaveTextContent('A new version is ready.'));
    } finally {
      vi.useRealTimers();
    }
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
