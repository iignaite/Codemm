import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { timing } from '../../app/useLoad';
import { mockWithCourse, renderApp } from '../../test-utils';

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

describe('usage', () => {
  const usage = (over: Partial<NonNullable<Awaited<ReturnType<CodemmApi['usage']>>>> = {}) => ({
    kinds: {},
    total: { input: 182_400, output: 12_300, cachedInput: 90_000, costUsd: 0.4231, runs: 6 },
    ...over,
  });

  it("shows the course's tokens, and Claude's cost as its own estimate, which a plan counts toward its usage", async () => {
    const { api } = await mockWithCourse();
    api.usage = async () => usage();
    renderApp({ to: 'learn' }, api);
    const section = await screen.findByRole('region', { name: 'Usage' });
    expect(section).toHaveTextContent('Tokens in182,400');
    expect(section).toHaveTextContent('Tokens out12,300');
    expect(section).toHaveTextContent("Claude's estimate$0.42");
    expect(section).toHaveTextContent("Claude's own estimate. On a Claude plan, this counts toward the plan's usage.");
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
