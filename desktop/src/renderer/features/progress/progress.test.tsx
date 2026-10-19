import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { timing } from '../../app/useLoad';
import { mockWithCourse, mockWithRoadmap, renderApp } from '../../test-utils';

async function master(api: CodemmApi, topics: number) {
  for (let i = 0; i < topics; i++) {
    await api.course();
    const now = (await api.course())!.topics.find((t) => t.state === 'now')!;
    for (const l of now.lessons) await api.markRead(l.id);
    const { id, files } = await api.activity(now.id);
    await api.saveFile(id, files[0].path, 'count + 1', files[0].digest);
    await api.check(id);
  }
}

describe('a course read that fails after one worked', () => {
  it('keeps the course on screen, says it could not refresh, and Try again reads again', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse({ read: true });
    const course = api.course.bind(api);
    let failing = false;
    api.course = () => (failing ? Promise.reject(new Error("codemm:offline")) : course());
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    failing = true;
    window.dispatchEvent(new Event('focus'));
    // A status (the sidebar keeps its own, for updates): this one says what happened.
    const notice = await screen.findByText(/Codemm couldn't refresh this/);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent("Codemm couldn't refresh this. You're offline.");
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Continue' });
    expect(screen.queryByText(/Codemm couldn't refresh this/)).not.toBeInTheDocument();
  });
});

describe('course map', () => {
  it('shows mastered, current and later topics, and continues the current one', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    await master(api, 2);
    renderApp({ to: 'learn' }, api);
    const map = await screen.findByRole('list', { name: 'Topics' });
    const items = within(map).getAllByRole('listitem');
    expect(within(items[0]).getByRole('img', { name: 'Mastered' })).toBeInTheDocument();
    expect(within(items[2]).getByRole('img', { name: 'Now' })).toBeInTheDocument();
    expect(within(items[3]).getByRole('img', { name: 'Later' })).toBeInTheDocument();

    expect(screen.getByRole('img', { name: 'JavaScript basics: mastered' })).toBeInTheDocument();

    await user.click(within(items[2]).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Components' })).toBeInTheDocument();
  });

  it('offers a due review on a mastered topic, and says when the next review is due', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    await master(api, 2);
    const real = await api.course();
    api.course = async () => ({
      ...real!,
      topics: real!.topics.map((t, i) => (i === 0 ? { ...t, review: 'due' as const, activity: 'open' as const } : i === 1 ? { ...t, reviewIn: 3 } : t)),
    });
    renderApp({ to: 'learn' }, api);
    const map = await screen.findByRole('list', { name: 'Topics' });
    const first = within(map).getAllByRole('listitem')[0]!;
    expect(within(first).getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText('Review in 3 days')).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Review', { selector: '.pill' })).toBeInTheDocument();
  });

  it('reads the course again when the window regains focus, so a review that came due shows up', async () => {
    const { api } = await mockWithCourse();
    const real = (await api.course())!;
    let reads = 0;
    let due = false;
    api.course = async () => {
      reads++;
      return due ? { ...real, topics: real.topics.map((t, i) => (i === 0 ? { ...t, state: 'mastered' as const, review: 'due' as const, activity: 'open' as const } : t)) } : real;
    };
    renderApp({ to: 'learn' }, api);
    await screen.findByRole('list', { name: 'Topics' });
    const before = reads;
    due = true;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(reads).toBeGreaterThan(before);
  });

  it('re-reads a settled course now and then, so a review that comes due while the screen stays open shows up', async () => {
    const idle = timing.idleMs;
    timing.idleMs = 30;
    try {
      const { api } = await mockWithCourse();
      const real = (await api.course())!;
      let due = false;
      api.course = async () => (due ? { ...real, topics: real.topics.map((t, i) => (i === 0 ? { ...t, state: 'mastered' as const, review: 'due' as const, activity: 'open' as const } : t)) } : real);
      renderApp({ to: 'learn' }, api);
      await screen.findByRole('list', { name: 'Topics' });
      due = true;
      expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    } finally {
      timing.idleMs = idle;
    }
  });

  it('keeps the review schedule on a finished course', async () => {
    const { api, course } = await mockWithCourse();
    await master(api, course.topics.length);
    const real = (await api.course())!;
    api.course = async () => ({ ...real, topics: real.topics.map((t, i) => (i === 0 ? { ...t, reviewIn: 1 } : t)) });
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('heading', { name: 'React complete' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Reviews' })).getByText(/Review tomorrow/)).toBeInTheDocument();
  });

  it('celebrates a finished course, then offers something new', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse();
    await master(api, course.topics.length);
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('heading', { name: 'React complete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Learn something new' }));
    expect(await screen.findByRole('heading', { name: 'What do you want to learn?' })).toBeInTheDocument();
  });

  it('opens a finished course, and a mastered topic, again', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse();
    await master(api, course.topics.length);
    renderApp({ to: 'learn' }, api);
    await user.click(await screen.findByRole('button', { name: 'View course' }));
    const map = await screen.findByRole('list', { name: 'Topics' });
    // Every leaf is mastered, and nothing is left to continue.
    expect(within(map).getAllByRole('img', { name: 'Mastered' })).toHaveLength(course.topics.length);
    expect(within(map).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    await user.click(within(map).getByRole('button', { name: 'JSX' }));
    expect(await screen.findByRole('heading', { name: 'JSX', level: 1 })).toBeInTheDocument();
  });

  it("says Codemm's records need a repair, and how", async () => {
    const { api } = await mockWithCourse();
    api.course = () => Promise.reject(new Error("codemm:repair\nThe learning log /h/events.jsonl has an invalid entry on line 3. Fix or remove that line, then retry."));
    renderApp({ to: 'learn' }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm's records need a repair.");
    expect(alert).toHaveTextContent('The learning log /h/events.jsonl has an invalid entry on line 3. Fix or remove that line, then retry.');
    expect(alert).not.toHaveTextContent('codemm:repair');
  });

  it("shows Codemm's own message for any other failure, not a connection problem", async () => {
    const { api } = await mockWithCourse();
    api.course = () => Promise.reject(new Error('Track python@3 offers unit, not style "io".'));
    renderApp({ to: 'learn' }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Track python@3 offers unit, not style "io".');
    expect(alert).not.toHaveTextContent("Couldn't reach Codemm.");
  });
});

describe('course path', () => {
  const items = async () => within(await screen.findByRole('list', { name: 'Topics' })).getAllByRole('listitem');

  it('is one list item per topic, marks where the learner is, and says how far into its lessons', async () => {
    const { api, course } = await mockWithCourse();
    await api.markRead(course.topics[0].lessons[0].id);
    renderApp({ to: 'learn' }, api);
    const all = await items();
    expect(all).toHaveLength(course.topics.length);
    expect(all[0]).toHaveAttribute('aria-current', 'step');
    expect(all.slice(1).filter((li) => li.hasAttribute('aria-current'))).toEqual([]);
    expect(all[0]).toHaveTextContent(`Lessons 1 of ${course.topics[0].lessons.length}`);
  });

  it('says the lessons are done once all are read', async () => {
    const { api } = await mockWithCourse({ read: true });
    renderApp({ to: 'learn' }, api);
    const [first] = await items();
    expect(within(first).getByText('Lessons')).toBeInTheDocument();
    expect(first).not.toHaveTextContent(/of \d/);
  });

  it('keeps a skipped topic on the path as Later, and moves Now to the next topic ready', async () => {
    const { api, course } = await mockWithCourse();
    await api.skip(course.topics[0].id);
    renderApp({ to: 'learn' }, api);
    const all = await items();
    expect(within(all[0]).getByRole('img', { name: 'Later' })).toBeInTheDocument();
    const now = all.findIndex((li) => li.getAttribute('aria-current') === 'step');
    expect(now).toBeGreaterThan(0);
    expect(within(all[now]).getByRole('img', { name: 'Now' })).toBeInTheDocument();
    expect(within(all[now]).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('puts an easier topic before the one it helps, as the one to do now', async () => {
    const { api } = await mockWithCourse();
    await master(api, 2);
    const stuck = (await api.course())!.topics.find((t) => t.state === 'now')!;
    await api.easier(stuck.id);
    renderApp({ to: 'learn' }, api);
    const all = await items();
    expect(all[2]).toHaveTextContent(`${stuck.title}: first steps`);
    expect(all[2]).toHaveAttribute('aria-current', 'step');
    expect(within(all[3]).getByRole('img', { name: 'Later' })).toBeInTheDocument();
  });

  it('says a review is being written, with nothing to press until it is', async () => {
    const { api } = await mockWithCourse();
    await master(api, 2);
    const real = (await api.course())!;
    api.course = async () => ({ ...real, topics: real.topics.map((t, i) => (i === 0 ? { ...t, review: 'writing' as const, activity: 'writing' as const } : t.state === 'now' ? { ...t, state: 'later' as const } : t)) });
    renderApp({ to: 'learn' }, api);
    const [first] = await items();
    expect(first).toHaveAttribute('aria-current', 'step');
    expect(within(first).getByText('Writing the review')).toBeInTheDocument();
    expect(within(first).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows setup progress while the track sets up, and the path stays usable', async () => {
    const { api, roadmap } = await mockWithRoadmap({ slow: 2 });
    await api.approve(roadmap.concepts);
    renderApp({ to: 'learn' }, api);
    const setup = await screen.findByRole('region', { name: 'Setting up React' }, { timeout: 10_000 });
    expect(within(setup).getByRole('progressbar', { name: 'Setting up React' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    // Once setup waits for consent, the topic page asks; the map stops showing progress.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Setting up React' })).not.toBeInTheDocument(), { timeout: 10_000 });
  });

  it('shows building once the learner consents', async () => {
    const { api, roadmap } = await mockWithRoadmap({ slow: 2 });
    await api.approve(roadmap.concepts);
    let course = (await api.course())!;
    while (course.setup !== 'consent') course = (await api.course())!;
    await api.install(course.proposal!.digest);
    renderApp({ to: 'learn' }, api);
    const setup = await screen.findByRole('region', { name: 'Setting up React' }, { timeout: 10_000 });
    await waitFor(() => expect(within(setup).getByText('Building')).toHaveAttribute('aria-current', 'step'));
  });

  it('is green only between topics reached, so topics passed over sit on grey', async () => {
    // Mastered, mastered, then the current topic: the two joins between them are green, each drawn from both sides.
    const { api, course } = await mockWithCourse();
    await master(api, 2);
    const { container, unmount } = renderApp({ to: 'learn' }, api);
    await items();
    expect(container.querySelectorAll('.seg.on')).toHaveLength(4);
    unmount();
    // Skipping the first topic moves Now past locked ones: nothing between them was reached.
    const fresh = await mockWithCourse();
    await fresh.api.skip(course.topics[0].id);
    const again = renderApp({ to: 'learn' }, fresh.api);
    await items();
    expect(again.container.querySelectorAll('.seg.on')).toHaveLength(0);
  });

  it('counts the topics mastered', async () => {
    const { api } = await mockWithCourse();
    await master(api, 2);
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('region', { name: 'Mastery' })).toHaveTextContent('2 of 8 topics');
  });

  it('goes along the path by keyboard: each mastered topic, then Continue, which Enter opens', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    await master(api, 2);
    renderApp({ to: 'learn' }, api);
    const map = await screen.findByRole('list', { name: 'Topics' });
    const order: string[] = [];
    for (let i = 0; i < 20 && order.length < 3; i++) {
      await user.tab();
      if (map.contains(document.activeElement)) order.push(document.activeElement!.textContent!);
    }
    expect(order).toEqual(['JavaScript basics', 'JSX', 'Continue']);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Components', level: 1 })).toBeInTheDocument();
  });
});

describe('usage', () => {
  const usage = (over: Partial<NonNullable<Awaited<ReturnType<CodemmApi['usage']>>>> = {}) => ({
    kinds: {},
    total: { input: 182_400, output: 12_300, cachedInput: 90_000, costUsd: 0.4231, runs: 6 },
    ...over,
  });

  it("shows the course's tokens, and Claude's cost as its estimate once, with no claim about billing", async () => {
    const { api } = await mockWithCourse();
    api.usage = async () => usage();
    renderApp({ to: 'learn' }, api);
    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(section).toHaveTextContent('Tokens in182,400');
    expect(section).toHaveTextContent('Tokens out12,300');
    expect(section).toHaveTextContent("Claude's estimate$0.42");
    // The row's label says it's an estimate; no footnote says it again.
    expect(section.textContent!.match(/estimate/g)).toHaveLength(1);
    // Codemm can't tell a plan from an API key, so it says nothing about either.
    expect(section).not.toHaveTextContent('plan');
    // No promise about charges: Codemm can't tell a plan from an API key.
    expect(section).not.toHaveTextContent('charge');
  });

  it('shows no cost when none was reported, and refreshes as jobs finish', async () => {
    const { api } = await mockWithCourse();
    let total = { input: 10, output: 2, cachedInput: 0, costUsd: 0, runs: 1 };
    api.usage = async () => usage({ total });
    renderApp({ to: 'learn' }, api);
    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(section).not.toHaveTextContent('estimate');
    // Whenever the map reads the course again (here: the window regains focus), it reads usage too.
    total = { ...total, input: 500, runs: 2 };
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(section).toHaveTextContent('Tokens in500'));
  });

  it('is hidden until an agent has run for the course', async () => {
    const { api } = await mockWithCourse();
    api.usage = async () => usage({ total: { input: 0, output: 0, cachedInput: 0, costUsd: 0, runs: 0 } });
    renderApp({ to: 'learn' }, api);
    await screen.findByRole('list', { name: 'Topics' });
    expect(screen.queryByRole('region', { name: 'Usage' })).not.toBeInTheDocument();
  });
});
