import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { createMock, scenario } from '../../../main/mock';
import { renderApp } from '../../test-utils';

async function approved(options?: Parameters<typeof createMock>[0]): Promise<CodemmApi> {
  const api = createMock(options);
  await api.approve({ title: 'React basics', track: 'React', installed: false, topics: ['State', 'Events'] });
  return api;
}

describe('lessons', () => {
  it('opens the first lesson while the rest is still being written and set up', async () => {
    const api = await approved();
    renderApp({ to: 'topic', topicId: 't1' }, api);
    expect(await screen.findByRole('heading', { name: 'State' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read What state is' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Read useState' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Opens after the lessons' })).toBeInTheDocument();
    expect(screen.queryByText('Setting up React')).not.toBeInTheDocument();
  });

  it('predicts, keeps a note, and moves on to the activity once both lessons are read', async () => {
    const user = userEvent.setup();
    const api = await approved();
    for (let i = 0; i < 3; i++) await api.course();
    await api.read('t1.1');
    renderApp({ to: 'lesson', lessonId: 't1.2' }, api);

    expect(await screen.findByRole('heading', { name: 'useState', level: 1 })).toBeInTheDocument();
    const outline = screen.getByRole('navigation', { name: 'State' });
    expect(within(outline).getByRole('button', { name: 'useState' })).toHaveAttribute('aria-current', 'page');

    const answer = screen.getByRole('group', { name: 'Your answer' });
    expect(screen.queryByText('Count: 2', { selector: '.shows' })).not.toBeInTheDocument();
    await user.click(within(answer).getByRole('button', { name: 'Count: 2' }));
    expect(within(answer).getByRole('button', { name: 'Count: 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Count: 2', { selector: '.shows' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox', { name: 'My note' }), 'The setter replaces the value.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The setter replaces the value.')).toBeInTheDocument();
    expect((await api.lesson('t1.2')).note).toBe('The setter replaces the value.');

    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why a setter?{Enter}');
    expect(await within(screen.getByRole('log')).findByText('Good question. Try it in the activity next.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('reopens a lesson instantly from the cache', async () => {
    const user = userEvent.setup();
    const api = await approved();
    for (let i = 0; i < 3; i++) await api.course();
    renderApp({ to: 'lesson', lessonId: 't1.2' }, api);
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    await user.click(screen.getByRole('button', { name: 'What state is' }));
    await screen.findByRole('heading', { name: 'What state is', level: 1 });
    api.lesson = () => new Promise(() => {});
    await user.click(screen.getByRole('button', { name: 'useState' }));
    expect(screen.getByRole('heading', { name: 'useState', level: 1 })).toBeInTheDocument();
  });

  it('forgets cached lessons when a new course replaces the old one', async () => {
    const user = userEvent.setup();
    const api = await approved();
    for (let i = 0; i < 3; i++) await api.course();
    await api.saveNote('t1.2', 'Old course note');
    const view = renderApp({ to: 'lesson', lessonId: 't1.2' }, api);
    expect(await screen.findByText('Old course note')).toBeInTheDocument();
    view.unmount();

    renderApp({ to: 'course', draft: { title: 'New course', track: 'React', installed: true, topics: ['State'] } }, api);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(await screen.findByRole('button', { name: 'Read What state is' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    expect(screen.queryByText('Old course note')).not.toBeInTheDocument();
  });

  it('shows a saved note after reopening, even if an older read finishes later', async () => {
    const user = userEvent.setup();
    const api = await approved();
    for (let i = 0; i < 3; i++) await api.course();
    renderApp({ to: 'lesson', lessonId: 't1.2' }, api);
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    await user.click(screen.getByRole('button', { name: 'What state is' }));
    await screen.findByRole('heading', { name: 'What state is', level: 1 });

    const lesson = api.lesson;
    let late: () => void = () => {};
    api.lesson = (id) => {
      const stale = lesson(id);
      return new Promise((done) => (late = () => done(stale)));
    };
    await user.click(screen.getByRole('button', { name: 'useState' }));
    api.lesson = lesson;
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByRole('textbox', { name: 'My note' }), 'Saved note');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved note')).toBeInTheDocument();
    late();

    await user.click(screen.getByRole('button', { name: 'What state is' }));
    await screen.findByRole('heading', { name: 'What state is', level: 1 });
    await user.click(screen.getByRole('button', { name: 'useState' }));
    expect(await screen.findByText('Saved note')).toBeInTheDocument();
  });

  it('says when setup failed because this computer is offline or low on disk, and retries', async () => {
    const user = userEvent.setup();
    const low = await approved(scenario('low-disk'));
    renderApp({ to: 'topic', topicId: 't1' }, low);
    expect(await screen.findByText('This computer is low on disk space. Free some space, then try again.')).toBeInTheDocument();
    cleanup();

    const api = await approved(scenario('offline-setup'));
    renderApp({ to: 'topic', topicId: 't1' }, api);
    expect(await screen.findByText('Setting up React needs the internet once. Connect, then try again.')).toBeInTheDocument();
    renderApp({ to: 'topic', topicId: 't1' }, api);
    const heading = await screen.findByRole('heading', { name: "Couldn't set up React" });
    const alert = heading.closest<HTMLElement>('[role="alert"]')!;
    expect(alert).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try now' }));
    expect(await screen.findByRole('heading', { name: 'State' })).toBeInTheDocument();
  });
});
