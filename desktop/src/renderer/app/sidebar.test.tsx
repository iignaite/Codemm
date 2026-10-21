import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMock } from '../../main/mock';
import { jobAt, jobBus, mockWithRoadmap, renderApp } from '../test-utils';

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
      // Its logo is Emm: the wordmark's "<" alone looks like a Back button.
      expect(sidebar().querySelector('.lg .emm')).not.toBeNull();
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

  it('keeps a running job in reach in the slim sidebar: Emm alone, named for what it is and its stage', async () => {
    const wide = narrowWindow();
    try {
      const api = createMock();
      const tell = jobBus(api);
      renderApp({ to: 'tracks' }, api);
      await screen.findByRole('heading', { name: 'Tracks' });
      act(() => tell(jobAt('s1', 'rebuild', { track: 'React', stage: 0, thinking: false })));
      const job = await within(sidebar()).findByRole('button', { name: 'Rebuilding React, Building and checking' });
      expect(job).not.toHaveTextContent('Rebuilding');
      expect(job).toHaveAttribute('title', 'Rebuilding React, Building and checking');
      // Wider again: the words come back.
      wide();
      expect(await within(sidebar()).findByText('Rebuilding React')).toBeInTheDocument();
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

/** A mock with two approved courses, React then Python; Python is on screen. */
async function twoCourses() {
  const { api, roadmap } = await mockWithRoadmap();
  await api.approve(roadmap.concepts);
  const goal = { topic: 'Python', known: '', depth: 'standard' as const };
  let r = await api.research(goal);
  while (r.state === 'running') r = await api.research(goal);
  await api.approve(r.roadmap!.concepts);
  return api;
}

describe('courses (§4.13)', () => {
  it('lists the courses at the foot, the one on screen marked, and opens another', async () => {
    renderApp({ to: 'learn' }, await twoCourses());
    const python = await within(sidebar()).findByRole('button', { name: 'Python' });
    expect(python).toHaveAttribute('aria-current', 'true');
    expect(within(sidebar()).getByRole('button', { name: 'React' })).not.toHaveAttribute('aria-current');
    expect(await screen.findByRole('heading', { level: 1, name: 'Python' })).toBeInTheDocument();
    await userEvent.setup().click(within(sidebar()).getByRole('button', { name: 'React' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'React' })).toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'React' })).toHaveAttribute('aria-current', 'true');
  });

  it('names two courses with the same words by their goals', async () => {
    const api = await twoCourses();
    api.courses = async () => [
      { id: 'python-1', title: 'Python', goal: 'Python basics, briefly', track: 'python', current: true },
      { id: 'python-2', title: 'Python', goal: 'Python in depth', track: 'python', current: false },
    ];
    renderApp({ to: 'tracks' }, api);
    expect(await within(sidebar()).findByRole('button', { name: 'Python basics, briefly' })).toHaveAttribute('aria-current', 'true');
    expect(within(sidebar()).getByRole('button', { name: 'Python in depth' })).toBeInTheDocument();
  });

  it('opens the goal screen from New course', async () => {
    renderApp({ to: 'learn' }, await twoCourses());
    await userEvent.setup().click(await within(sidebar()).findByRole('button', { name: 'New course' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('shows one course as before, with New course; none says so', async () => {
    const { api, roadmap } = await mockWithRoadmap();
    const view = renderApp({ to: 'tracks' }, api);
    expect(await within(sidebar()).findByText('No course yet')).toBeInTheDocument();
    expect(within(sidebar()).queryByRole('button', { name: 'New course' })).not.toBeInTheDocument();
    view.unmount();
    await api.approve(roadmap.concepts);
    renderApp({ to: 'tracks' }, api);
    expect(await within(sidebar()).findByRole('button', { name: 'React' })).toHaveAttribute('aria-current', 'true');
    expect(within(sidebar()).getByRole('button', { name: 'New course' })).toBeInTheDocument();
  });

  it("doesn't say there is no course while the first one's roadmap or research is open, and offers New course", async () => {
    const { api, roadmap } = await mockWithRoadmap();
    const view = renderApp({ to: 'course', roadmap }, api);
    expect(await within(sidebar()).findByRole('button', { name: 'New course' })).toBeInTheDocument();
    expect(within(sidebar()).queryByText('No course yet')).not.toBeInTheDocument();
    view.unmount();
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    expect(await within(sidebar()).findByRole('button', { name: 'New course' })).toBeInTheDocument();
    expect(within(sidebar()).queryByText('No course yet')).not.toBeInTheDocument();
  });

  it('shows each course as its badge in the slim sidebar, named by its goal', async () => {
    narrowWindow();
    try {
      renderApp({ to: 'tracks' }, await twoCourses());
      const react = await within(sidebar()).findByRole('button', { name: 'React' });
      expect(react).toHaveTextContent('R');
      expect(within(sidebar()).getByRole('button', { name: 'Python' })).toHaveAttribute('aria-current', 'true');
      await userEvent.setup().click(react);
      expect(await screen.findByRole('heading', { level: 1, name: 'React' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
