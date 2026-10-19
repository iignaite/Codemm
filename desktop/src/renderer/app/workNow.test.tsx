import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock } from '../../main/mock';
import { jobAt, jobBus, mockWithCourse, mockWithRoadmap, renderApp } from '../test-utils';

const TOPIC = 'javascript-basics';
const GOAL = { topic: 'React', known: '', depth: 'standard' as const };
const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
const working = () => within(sidebar()).queryByRole('list', { name: 'Codemm is working' });
/** What each listed job says, in order: what it is, then its stage. */
const names = () => within(working()!).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
const goTo = (user: ReturnType<typeof userEvent.setup>, place: 'Learn' | 'Tracks') => user.click(within(sidebar()).getByRole('button', { name: place }));

describe('running jobs in the sidebar (§4.11)', () => {
  it("keeps a track's setup in view after the learner leaves the topic page, and opens it again", async () => {
    const user = userEvent.setup();
    // Slow enough that the job is still on its first stage however long the clicks take.
    const { api, roadmap } = await mockWithRoadmap({ slow: 20 });
    await api.approve(roadmap.concepts);
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await screen.findByRole('group', { name: 'Setting up React' });
    // The topic page shows the whole bar, so the sidebar doesn't repeat it (its other bars take a moment to mount).
    await waitFor(() => expect(working()).not.toBeInTheDocument());

    await goTo(user, 'Tracks');
    const job = await within(sidebar()).findByRole('button', { name: 'Setting up React, Proposing the setup' });
    await user.click(job);
    expect(await screen.findByRole('heading', { name: 'JavaScript basics' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Setting up React' })).toBeInTheDocument();
    await waitFor(() => expect(working()).not.toBeInTheDocument());
  });

  it('keeps research in view after the learner leaves its screen, and opens it again', async () => {
    const user = userEvent.setup();
    const api = createMock({ slow: 20 });
    await api.connect('claude');
    renderApp({ to: 'research', goal: GOAL }, api);
    await screen.findByRole('group', { name: 'Researching React' });
    expect(working()).not.toBeInTheDocument();

    await goTo(user, 'Tracks');
    await user.click(await within(sidebar()).findByRole('button', { name: 'Researching React, Researching' }));
    expect(await screen.findByRole('heading', { name: 'Researching React' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Researching React' })).toBeInTheDocument();
    await waitFor(() => expect(working()).not.toBeInTheDocument());
  });

  it('shows a rebuild on the Tracks page, and in the sidebar everywhere else', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    const tell = jobBus(api);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const rebuilding = jobAt('rb', 'rebuild', { track: 'React', stage: 0, thinking: false });
    api.rebuild = async () => {
      tell(rebuilding);
      await released;
      tell({ ...rebuilding, ended: true });
    };
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    expect(await within(react).findByRole('group', { name: 'Rebuilding React' })).toHaveTextContent('Building and checking');
    expect(within(react).getByRole('button', { name: 'Rebuild' })).toBeDisabled();
    expect(working()).not.toBeInTheDocument();

    await goTo(user, 'Learn');
    await user.click(await within(sidebar()).findByRole('button', { name: 'Rebuilding React, Building and checking' }));
    // Back on Tracks, which was left mid-rebuild: the card shows it again, and the sidebar stands down.
    const again = await screen.findByRole('listitem', { name: 'React' });
    expect(await within(again).findByRole('group', { name: 'Rebuilding React' })).toBeInTheDocument();
    expect(within(again).getByRole('button', { name: 'Rebuild' })).toBeDisabled();
    expect(working()).not.toBeInTheDocument();
    // It ends: the card is free again, and nothing is left in the sidebar.
    act(() => release());
    await waitFor(() => expect(within(again).queryByRole('group', { name: 'Rebuilding React' })).not.toBeInTheDocument());
    expect(within(again).getByRole('button', { name: 'Rebuild' })).toBeEnabled();
    expect(working()).not.toBeInTheDocument();
  });

  it('names each long job and its stage, and opens the place it belongs to', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse({ read: true });
    const tell = jobBus(api);
    renderApp({ to: 'tracks' }, api);
    await screen.findByRole('heading', { name: 'Tracks' });
    expect(working()).not.toBeInTheDocument();

    act(() => tell(jobAt('l1', 'lesson', { concept: TOPIC })));
    act(() => tell(jobAt('a1', 'author', { concept: TOPIC, stage: 2, part: { done: 2, total: 3 } })));
    act(() => tell(jobAt('r1', 'roadmap')));
    expect(names()).toEqual([
      'Writing a lesson on JavaScript basics, Writing the lesson',
      'Writing an activity on JavaScript basics, Checking the exercise, step 2 of 3',
      'Changing the roadmap, Changing the roadmap',
    ]);

    // A retry reads short; a job quiet for 90 seconds says it is still working; a finished job leaves.
    act(() => tell(jobAt('l1', 'lesson', { concept: TOPIC, retry: { attempt: 2, of: 3 } })));
    act(() => tell(jobAt('a1', 'author', { concept: TOPIC, idleMs: 95_000 })));
    act(() => tell({ ...jobAt('r1', 'roadmap'), ended: true }));
    expect(names()).toEqual(['Writing a lesson on JavaScript basics, Taking a little longer', 'Writing an activity on JavaScript basics, Still working']);

    await user.click(within(working()!).getByRole('button', { name: /^Writing a lesson/ }));
    expect(await screen.findByRole('heading', { name: 'JavaScript basics' })).toBeInTheDocument();
  });

  it("shows no more than one of a kind's overlapping jobs, the furthest along, and leaves the tutor to its rail", async () => {
    const { api } = await mockWithCourse({ read: true });
    const tell = jobBus(api);
    renderApp({ to: 'tracks' }, api);
    await screen.findByRole('heading', { name: 'Tracks' });
    // A proposing agent ends its turn while Codemm's install runs.
    act(() => tell(jobAt('proposal', 'setup', { stage: 0 })));
    act(() => tell(jobAt('install', 'setup', { stage: 1, part: { done: 3, total: 7 }, thinking: false })));
    act(() => tell(jobAt('turn', 'tutor', { stage: 0 })));
    expect(names()).toEqual(['Setting up React, Building, step 3 of 7']);
  });

  it('opens the roadmap being changed in its editor', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithRoadmap();
    const tell = jobBus(api);
    renderApp({ to: 'tracks' }, api);
    await screen.findByRole('heading', { name: 'Tracks' });
    act(() => tell(jobAt('r1', 'roadmap')));
    await user.click(within(working()!).getByRole('button', { name: /^Changing the roadmap/ }));
    expect(await screen.findByRole('heading', { name: 'React' })).toBeInTheDocument();
  });

  it("doesn't repeat a job whose bar the screen shows, and still shows the others", async () => {
    const { api } = await mockWithCourse({ read: true });
    const real = (await api.course())!;
    api.course = async () => ({ ...real, topics: real.topics.map((t) => (t.id === TOPIC ? { ...t, lessons: t.lessons.map((l, i) => (i === 0 ? { ...l, state: 'writing' as const } : l)) } : t)) });
    const tell = jobBus(api);
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await screen.findByRole('heading', { name: 'JavaScript basics' });
    act(() => tell(jobAt('l1', 'lesson', { concept: TOPIC })));
    expect(await screen.findByRole('group', { name: 'Writing the lesson' })).toBeInTheDocument();
    expect(working()).not.toBeInTheDocument();
    // Another topic's lesson has no bar on this page.
    act(() => tell(jobAt('l2', 'lesson', { concept: 'other' })));
    expect(within(working()!).getAllByRole('button')).toHaveLength(1);
  });

  it("leaves a setup to the topic page that shows it, whichever of its overlapping jobs the page follows", async () => {
    const { api } = await mockWithCourse({ read: true });
    const real = (await api.course())!;
    api.course = async () => ({ ...real, setup: 'installing' as const });
    const tell = jobBus(api);
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await screen.findByRole('heading', { name: 'JavaScript basics' });
    // The install runs while the proposing agent still ends its turn: the page follows the install.
    act(() => tell(jobAt('install', 'setup', { stage: 1, thinking: false })));
    act(() => tell(jobAt('proposal', 'setup', { stage: 0 })));
    expect(await screen.findByRole('group', { name: 'Setting up React' })).toBeInTheDocument();
    expect(working()).not.toBeInTheDocument();
  });

  it('hands the keyboard focus to the navigation when the job it is on ends', async () => {
    const { api } = await mockWithCourse({ read: true });
    const tell = jobBus(api);
    renderApp({ to: 'learn' }, api);
    await screen.findByRole('heading', { name: 'React' });
    const rebuilding = jobAt('rb', 'rebuild', { track: 'React', stage: 0, thinking: false });
    act(() => tell(rebuilding));
    const job = within(working()!).getByRole('button');
    act(() => job.focus());
    expect(job).toHaveFocus();
    act(() => tell({ ...rebuilding, ended: true }));
    expect(working()).not.toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'Learn' })).toHaveFocus();
  });
});
