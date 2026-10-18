// jsdom can't lay out xterm.js; this stand-in takes typing. The pane's text mirror shows what was written.
const xterm = vi.hoisted(() => ({ type: (_data: string) => undefined as void }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {};
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    onData(listener: (data: string) => void) {
      xterm.type = listener;
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
    attachCustomKeyEventHandler() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
    expect(await screen.findByRole('img', { name: 'Writing the review' })).toBeInTheDocument();
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
    expect(screen.getByRole('img', { name: 'Opens after the lessons' })).toBeInTheDocument();
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

  it('says when Docker stopped during setup, and offers Check this computer', async () => {
    const user = userEvent.setup();
    const { api } = await approved({ setupProblem: 'docker' });
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

describe('the activity while the agent writes it', () => {
  it('shows it being written, not locked, once every lesson is read', async () => {
    const { api, course } = await mockWithCourse({ read: true });
    // The real core reports `writing` for the current topic until the author job saves an exercise.
    const writing = { ...course, topics: course.topics.map((t, i) => (i === 0 ? { ...t, activity: 'writing' as const } : t)) };
    api.course = async () => writing;
    renderApp({ to: 'topic', topicId: course.topics[0].id }, api);
    expect(await screen.findByRole('img', { name: 'Writing the activity' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Opens after the lessons' })).not.toBeInTheDocument();
  });
});
