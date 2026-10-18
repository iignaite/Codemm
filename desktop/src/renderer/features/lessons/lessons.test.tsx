vi.mock('@xterm/xterm', () => import('../../testing/xterm'));
vi.mock('@xterm/addon-fit', () => import('../../testing/xterm'));

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JobProgress } from '../../../shared/api';
import { xterm } from '../../testing/xterm';
import { scenario, type MockOptions } from '../../../main/mock';
import { mockWithCourse, mockWithRoadmap, renderApp } from '../../test-utils';

const TOPIC = 'javascript-basics';

async function approved(options?: MockOptions) {
  const { api, roadmap } = await mockWithRoadmap(options);
  await api.approve(roadmap.concepts);
  return { api, roadmap };
}

describe('review on the topic page', () => {
  it('labels a due review and opens it, and shows a review being written', async () => {
    const { api } = await mockWithCourse({ read: true });
    const real = (await api.course())!;
    const withReview = (review: 'due' | 'writing') => async () => ({
      ...real,
      topics: real.topics.map((t) => (t.id === TOPIC ? { ...t, state: 'mastered' as const, review, activity: review === 'due' ? ('open' as const) : ('writing' as const) } : t)),
    });
    api.course = withReview('due');
    const view = renderApp({ to: 'topic', topicId: TOPIC }, api);
    expect(await screen.findByText('Review', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    view.unmount();
    api.course = withReview('writing');
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    expect(await screen.findByText('Writing the review')).toBeInTheDocument();
  });
});

describe('lesson examples', () => {
  it('shows each example where the lesson places it, and runs it on request', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true });
    const first = course.topics[0].lessons[0];
    const real = await api.lesson(first.id);
    api.lesson = async () => ({ ...real, markdown: 'Before\n\n```example\n1\n```\n\nAfter', examples: [{ files: [{ path: 'main.js', text: 'console.log(1)' }] }] });
    const runs: number[] = [];
    api.runExample = async (_id, n) => (runs.push(n), { kind: 'ran', exit: 0, output: '1\n', errors: '' });
    renderApp({ to: 'lesson', lessonId: first.id }, api);
    const example = await screen.findByRole('region', { name: 'Example 1' });
    expect(example).toHaveTextContent('console.log(1)');
    await user.click(within(example).getByRole('button', { name: 'Run' }));
    expect(await within(example).findByText('1', { selector: 'pre.out' })).toBeInTheDocument();
    expect(runs).toEqual([1]);
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
  });

  it('runs an io example in the terminal pane with typed input, and stops it on leaving', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true, style: 'io' });
    const first = course.topics[0].lessons[0];
    const stopped: string[] = [];
    const stopRun = api.stopRun.bind(api);
    api.stopRun = async (run) => (stopped.push(run), stopRun(run));
    const view = renderApp({ to: 'lesson', lessonId: first.id }, api);
    const example = await screen.findByRole('region', { name: 'Example 1' });
    expect(within(example).queryByRole('region', { name: 'Terminal for Example 1' })).toBeNull();
    await user.click(within(example).getByRole('button', { name: 'Run' }));
    const mirror = () => within(example).getByRole('log', { name: 'Terminal for Example 1, as text' });
    await waitFor(() => expect(mirror().textContent).toBe("What's your name? "));
    expect(within(example).getByRole('region', { name: 'Terminal for Example 1' })).toHaveTextContent('2:00 left');
    act(() => xterm.type('Ada\r'));
    await waitFor(() => expect(mirror().textContent).toBe("What's your name? Ada\nHello, Ada!\nExited with code 0.\n"));
    expect(within(example).getByRole('button', { name: 'Run' })).toBeEnabled();

    await user.click(within(example).getByRole('button', { name: 'Run' }));
    expect(await within(example).findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    view.unmount();
    expect(stopped).toHaveLength(1);
  });

  it('runs an io example under StrictMode, as the app does, where every effect replays once', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true, style: 'io' });
    renderApp({ to: 'lesson', lessonId: course.topics[0].lessons[0].id }, api, { strict: true });
    const example = await screen.findByRole('region', { name: 'Example 1' });
    await user.click(within(example).getByRole('button', { name: 'Run' }));
    const mirror = () => within(example).getByRole('log', { name: 'Terminal for Example 1, as text' });
    await waitFor(() => expect(mirror().textContent).toBe("What's your name? "));
    act(() => xterm.type('Ada\r'));
    await waitFor(() => expect(mirror().textContent).toBe("What's your name? Ada\nHello, Ada!\nExited with code 0.\n"));
  });
});

describe('job progress on the topic page (§4.11)', () => {
  it('shows setup and the lesson being written as staged progress, then the lesson to read', async () => {
    const { api } = await approved({ slow: 3 });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    const setup = await screen.findByRole('group', { name: 'Setting up React' });
    expect(within(setup).getByRole('listitem', { current: 'step' })).toHaveTextContent('Proposing the setup');
    const lesson = await screen.findByRole('group', { name: 'Writing the lesson' });
    expect(within(lesson).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Starting', 'Writing the lesson', 'Saving the lesson']);
    expect(await screen.findByRole('button', { name: 'Read useState' }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Writing the lesson' })).not.toBeInTheDocument();
  }, 15_000);
});

describe('setup progress while a proposing agent ends its turn', () => {
  it("follows the install's job, not the proposal's late events or its end", async () => {
    let hear: (p: JobProgress) => void = () => undefined;
    const { api } = await approved();
    api.onJobProgress = (listener) => ((hear = listener), () => undefined);
    const real = (await api.course())!;
    api.course = async () => ({ ...real, setup: 'installing' as const });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await screen.findByRole('heading', { name: 'JavaScript basics' });
    // The screen subscribes again once it knows setup is installing.
    await waitFor(() => expect(screen.getByText('Setting up React', { exact: false })).toBeInTheDocument());
    const at = (job: string, stage: number, ended?: true): JobProgress => ({ job, kind: 'setup', stage, steps: [], count: 0, thinking: false, elapsedMs: 0, idleMs: 0, ...(ended ? { ended } : {}) });
    act(() => hear(at('install', 1)));
    act(() => hear(at('proposal', 0)));
    act(() => hear(at('proposal', 0, true)));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Setting up React' })).getByRole('listitem', { current: 'step' })).toHaveTextContent('Building'));
  });
});

describe('topic page and setup consent', () => {
  it('asks once before setup, shows exactly what will be built, and sets up', async () => {
    const user = userEvent.setup();
    const { api } = await approved();
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    const dialog = await screen.findByRole('dialog', { name: 'Set up React on this computer?' });
    expect(dialog).toHaveTextContent('Setup runs code your agent wrote, with internet access. Graded runs are offline.');
    await user.click(within(dialog).getByText('Details'));
    expect(within(dialog).getByRole('region', { name: 'Dockerfile' })).toHaveTextContent('FROM node:22-alpine');
    expect(dialog).toHaveTextContent('The build stops after 10 minutes, and has no memory or CPU limit.');

    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up React' }));
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('button', { name: 'Read useState' })).toBeInTheDocument();
    expect(screen.queryByText(/Setting up React/)).not.toBeInTheDocument();
    expect(screen.getByText('Opens after you finish the lessons')).toBeInTheDocument();
  });

  it('reaches Details from the keyboard', async () => {
    const user = userEvent.setup();
    const { api } = await approved();
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await screen.findByRole('dialog');
    await user.tab({ shift: true });
    expect(screen.getByText('Details')).toHaveFocus();
  });

  it('shows the latest proposal again, inside the dialog, when the setup changed', async () => {
    const user = userEvent.setup();
    const { api } = await approved();
    const install = api.install;
    let first = true;
    api.install = (digest) => (first ? ((first = false), Promise.reject(new Error('The setup changed. Look at it again.'))) : install(digest));
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The setup changed. Look at it again.');
    await user.click(within(dialog).getByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('button', { name: 'Read useState' })).toBeInTheDocument();
  });

  it('says when setup failed offline or on low disk, and tries the same setup again', async () => {
    const user = userEvent.setup();
    for (const [name, text] of [['offline-setup', "You're offline."], ['low-disk', 'Not enough disk space.']] as const) {
      const { api } = await approved(scenario(name));
      const view = renderApp({ to: 'topic', topicId: TOPIC }, api);
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      await user.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Read useState' })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('keeps the lesson list beside a failed setup', async () => {
    const user = userEvent.setup();
    const { api } = await approved(scenario('offline-setup'));
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You're offline.");
    expect(screen.getByRole('heading', { name: 'JavaScript basics' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Read What javascript basics is' })).toBeInTheDocument();
  });

  it('offers setup from a lesson without blocking the reading', async () => {
    const user = userEvent.setup();
    const { api } = await approved();
    let course = (await api.course())!;
    while (course.setup !== 'consent' || course.topics[0].lessons[0].state !== 'ready') course = (await api.course())!;
    renderApp({ to: 'lesson', lessonId: course.topics[0].lessons[0].id }, api);
    expect(await screen.findByRole('heading', { name: 'What javascript basics is' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up React' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Set up React on this computer?' })).getByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Set up React' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says when Docker stopped during setup, and offers Check this computer', async () => {
    const user = userEvent.setup();
    const { api } = await approved({ setupProblem: 'docker', docker: 'stopped' });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Docker stopped.');
    await user.click(within(alert).getByRole('button', { name: 'Check this computer' }));
    expect(await screen.findByRole('heading', { name: 'Check this computer' })).toBeInTheDocument();
  });

  it('asks again with a new proposal when the gates fail', async () => {
    const user = userEvent.setup();
    const { api } = await approved(scenario('setup-gates'));
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: "Couldn't set up React" })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Codemm has another way to set up React.' })).toBeInTheDocument();
  });
});

describe('background work that stopped', () => {
  it('says so, and starts it again', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse({ stalled: 'failed' });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm couldn't finish that.");
    expect(within(alert).getByRole('button', { name: 'Check your agent' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('says when Codemm could not stop the agent, with no way to retry until quitting', async () => {
    const { api } = await mockWithCourse({ stalled: 'unstoppable' });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm couldn't stop your agent. Quit Codemm to stop it.");
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the computer is offline, with Try again and no Check your agent', async () => {
    const { api } = await mockWithCourse({ stalled: 'offline' });
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("You're offline. Connect to the internet, then try again.");
    expect(within(alert).getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again']);
  });

  it('names a plan limit', async () => {
    const { api } = await mockWithCourse({ stalled: 'plan-limit' });
    renderApp({ to: 'learn' }, api);
    expect(await screen.findByRole('alert')).toHaveTextContent("Your agent's plan limit is reached. Try again later.");
  });

  it('goes to connect when the agent signed out, and goes on once it is connected again', async () => {
    const options: MockOptions = {};
    const { api } = await mockWithCourse(options);
    options.stalled = 'signed-out';
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    expect(await screen.findByRole('heading', { name: 'Connect an agent' })).toBeInTheDocument();
    await api.connect('claude');
    expect((await api.course())!.stalled).toBeUndefined();
  });

  it('keeps looking while the activity is being written', async () => {
    const { api } = await mockWithCourse({ read: true });
    const course = api.course;
    let writing = 3;
    api.course = async () => {
      const c = (await course())!;
      return writing-- > 0 ? { ...c, topics: c.topics.map((t) => (t.state === 'now' ? { ...t, activity: 'writing' as const } : t)) } : c;
    };
    renderApp({ to: 'topic', topicId: TOPIC }, api);
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});

describe('stalled work beside a lesson', () => {
  it('shows the banner on the lesson page, and Try again clears it', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse({ stalled: 'failed' });
    renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Codemm couldn't finish that.");
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('keeps looking while the activity is being written, so a stall shows up while reading', async () => {
    const options: MockOptions = {};
    const { api } = await mockWithCourse(options);
    const course = api.course;
    api.course = async () => {
      const c = (await course())!;
      return { ...c, topics: c.topics.map((t) => (t.state === 'now' ? { ...t, activity: 'writing' as const } : t)) };
    };
    renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    options.stalled = 'failed';
    expect(await screen.findByRole('alert')).toHaveTextContent("Codemm couldn't finish that.");
  });
});

describe('lessons', () => {
  it('reads a static lesson, keeps a note, and moves on to the activity once both lessons are read', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    await api.markRead(`${TOPIC}-1`);
    renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);

    expect(await screen.findByRole('heading', { name: 'useState', level: 1 })).toBeInTheDocument();
    expect(document.querySelector('.md pre code')).toHaveTextContent('const [count, setCount] = useState(0);');
    const outline = screen.getByRole('navigation', { name: 'JavaScript basics' });
    expect(within(outline).getByRole('button', { name: 'useState' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox', { name: 'My note' }), 'The setter replaces the value.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The setter replaces the value.')).toBeInTheDocument();
    expect((await api.lesson(`${TOPIC}-2`)).notes).toBe('The setter replaces the value.');

    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why a setter?{Enter}');
    expect(await within(screen.getByRole('log')).findByText('Good question. Try it in the activity next.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('reopens a lesson instantly from the cache', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    await user.click(screen.getByRole('button', { name: 'What javascript basics is' }));
    await screen.findByRole('heading', { name: 'What javascript basics is', level: 1 });
    api.lesson = () => new Promise(() => {});
    await user.click(screen.getByRole('button', { name: 'useState' }));
    expect(screen.getByRole('heading', { name: 'useState', level: 1 })).toBeInTheDocument();
  });

  it('forgets cached lessons when a new course replaces the old one', async () => {
    const user = userEvent.setup();
    const { api, roadmap } = await approved();
    await api.saveNotes(`${TOPIC}-2`, 'Old course note');
    const view = renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);
    expect(await screen.findByText('Old course note')).toBeInTheDocument();
    view.unmount();

    renderApp({ to: 'course', roadmap }, api);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Not now' }));
    await user.click(await screen.findByRole('button', { name: 'Read useState' }));
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    expect(screen.queryByText('Old course note')).not.toBeInTheDocument();
  });

  it('shows a saved note after reopening, even if an older read finishes later', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    renderApp({ to: 'lesson', lessonId: `${TOPIC}-2` }, api);
    await screen.findByRole('heading', { name: 'useState', level: 1 });
    await user.click(screen.getByRole('button', { name: 'What javascript basics is' }));
    await screen.findByRole('heading', { name: 'What javascript basics is', level: 1 });

    const lesson = api.lesson;
    let late: () => void = () => {};
    api.lesson = (id) => {
      const stale = lesson(id);
      return new Promise((done) => (late = () => done(stale)));
    };
    await user.click(screen.getByRole('button', { name: 'useState' }));
    api.lesson = lesson;
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox', { name: 'My note' }), 'Saved note');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved note')).toBeInTheDocument();
    late();

    await user.click(screen.getByRole('button', { name: 'What javascript basics is' }));
    await screen.findByRole('heading', { name: 'What javascript basics is', level: 1 });
    await user.click(screen.getByRole('button', { name: 'useState' }));
    expect(await screen.findByText('Saved note')).toBeInTheDocument();
  });
});

describe('a locked activity', () => {
  it('says why, in the lesson outline too, until the lessons are read', async () => {
    const { api, course } = await mockWithCourse();
    const lesson = course.topics[0].lessons[0].id;
    renderApp({ to: 'lesson', lessonId: lesson }, api);
    const outline = await screen.findByRole('navigation', { name: 'JavaScript basics' });
    expect(within(outline).getByText('Opens after you finish the lessons')).toBeInTheDocument();
  });
});

describe('the activity while the agent writes it', () => {
  it('shows it being written, not locked, once every lesson is read', async () => {
    const { api, course } = await mockWithCourse({ read: true });
    // The real core reports `writing` for the current topic until the author job saves an exercise.
    const writing = { ...course, topics: course.topics.map((t, i) => (i === 0 ? { ...t, activity: 'writing' as const } : t)) };
    api.course = async () => writing;
    renderApp({ to: 'topic', topicId: course.topics[0].id }, api);
    expect(await screen.findByText('Writing the activity')).toBeInTheDocument();
    expect(screen.queryByText('Opens after you finish the lessons')).not.toBeInTheDocument();
  });

  it('says it waits for the lesson while that is still being written, and shows no placeholder', async () => {
    const { api, course } = await mockWithCourse({ read: true });
    const first = course.topics[0];
    const waiting = { ...course, topics: course.topics.map((t, i) => (i === 0 ? { ...t, activity: 'writing' as const, lessons: [...first.lessons, { id: 'x-writing', title: 'Lesson', state: 'writing' as const }] } : t)) };
    api.course = async () => waiting;
    renderApp({ to: 'topic', topicId: first.id }, api);
    expect(await screen.findByText('Waiting for the lesson')).toBeInTheDocument();
    expect(document.querySelector('.shim')).toBeNull();
  });
});
