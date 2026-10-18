import { act, screen, within } from '@testing-library/react';
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
      await vi.waitFor(() => expect(region).toHaveTextContent('Codemm 1.2.0 is ready.'));
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

/** A narrow window from here on, until `wide()`. */
function narrowWindow() {
  let narrow = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(max-width: 760px)' && narrow;
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  }));
  return () => {
    narrow = false;
    act(() => listeners.forEach((l) => l()));
  };
}

describe('narrow windows', () => {
  it('slims the sidebar below 760 px (a narrow window, or 200% zoom), so the screen keeps its room', async () => {
    const wide = narrowWindow();
    try {
      renderApp({ to: 'tracks' });
      expect(await screen.findByRole('navigation', { name: 'Main' })).toHaveClass('slim');
      expect(within(sidebar()).getByRole('button', { name: 'Tracks' })).not.toHaveTextContent('Tracks');
      // Wider again: the full sidebar comes back.
      wide();
      expect(sidebar()).toHaveClass('side');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a new version in reach in the slim sidebar: Update links to the release', async () => {
    narrowWindow();
    try {
      renderApp({ to: 'tracks' }, createMock({ update: { kind: 'available', version: '1.2.0', url: 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0' } }));
      const region = await within(sidebar()).findByRole('status', { name: 'Codemm updates' });
      await vi.waitFor(() => expect(region).toHaveTextContent('A new version is available.'));
      expect(within(region).getByRole('link', { name: 'Update' })).toHaveAttribute('href', 'https://github.com/iignaite/Codemm/releases/tag/v1.2.0');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('and Restart once a signed build has it', async () => {
    narrowWindow();
    try {
      const api = createMock({ update: { kind: 'ready', version: '1.2.0' } });
      const restart = vi.spyOn(api, 'restartToUpdate');
      renderApp({ to: 'tracks' }, api);
      const region = await within(sidebar()).findByRole('status', { name: 'Codemm updates' });
      await userEvent.setup().click(await within(region).findByRole('button', { name: 'Restart' }));
      expect(region).toHaveTextContent('A new version is ready.');
      expect(restart).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
