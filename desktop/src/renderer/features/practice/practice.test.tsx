import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { xterm } from '../../testing/xterm';
import { scenario } from '../../../main/mock';
import { mockWithCourse, renderApp } from '../../test-utils';

vi.mock('@xterm/xterm', () => import('../../testing/xterm'));
vi.mock('@xterm/addon-fit', () => import('../../testing/xterm'));

async function open(options?: Parameters<typeof mockWithCourse>[0]) {
  const { api, course } = await mockWithCourse({ read: true, ...options });
  const view = renderApp({ to: 'practice', concept: course.topics[0].id }, api);
  await screen.findByRole('heading', { name: 'Click Counter' });
  return { ...view, course, user: userEvent.setup() };
}

const results = () => screen.getByRole('region', { name: 'Results' });
const code = () => screen.getByRole('textbox', { name: 'Counter.jsx' }) as HTMLTextAreaElement;

async function write(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(code());
  await user.type(code(), text);
}

async function checkUntilStuck(user: ReturnType<typeof userEvent.setup>) {
  await write(user, 'wrong /* your code */');
  for (let i = 0; i < 3; i++) {
    await user.click(screen.getByRole('button', { name: 'Check' }));
    // Stuck shows the ways forward above the failed results, so both headings may be there.
    await within(results()).findAllByRole('heading', { name: /passed|Try another way/ });
  }
}

describe('practice', () => {
  it('opens the activity with its statement, and only Check is graded', async () => {
    await open();
    expect(screen.getByRole('region', { name: 'Click Counter' })).toHaveTextContent('Make the count go up by one on each click.');
    expect(code().value).toContain('/* your code */');
    expect(results()).toHaveAttribute('aria-live', 'polite');
    expect(results()).toHaveTextContent('Only Check is graded.');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('tries the visible tests without grading', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await within(results()).findByRole('heading', { name: '1 of 2 visible tests passed' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('Not graded');
    expect(results()).toHaveTextContent('expected Count: 1');
    expect(results()).toHaveTextContent('found Count: 0');
  });

  it("shows hidden tests as statuses only, and says an unedited starter isn't counted", async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: '2 of 4 passed' })).toBeInTheDocument();
    expect(results()).toHaveTextContent("Change the code first. This check wasn't counted.");
    expect(within(results()).getByRole('img', { name: 'Hidden test 1 passed' })).toBeInTheDocument();
    expect(within(results()).getByRole('img', { name: 'Hidden test 2 not yet' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('graded, not shown');
  });

  it("saves the learner's code, then passes and continues to the course", async () => {
    const { user } = await open();
    await write(user, 'count + 1');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: '4 of 4 passed' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('JavaScript basics mastered.');
    await user.click(within(results()).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('list', { name: 'Topics' })).toBeInTheDocument();
  });

  it('keeps unchecked code when the learner leaves and comes back', async () => {
    const { user } = await open();
    await write(user, 'draft');
    await user.click(screen.getByRole('button', { name: 'Learn' }));
    await screen.findByRole('list', { name: 'Topics' });
    await user.click(screen.getByRole('button', { name: 'Practice' }));
    expect(await screen.findByRole('textbox', { name: 'Counter.jsx' })).toHaveValue('draft');
  });

  it('reloads a file that changed outside Codemm', async () => {
    const { user, api, course } = await open();
    const activity = await api.activity(course.topics[0].id);
    await api.saveFile(activity.id, 'Counter.jsx', 'changed outside', activity.files[0].digest);
    await user.type(code(), 'x');
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await within(screen.getByRole('log')).findByText('This file changed outside Codemm, so it was reloaded.')).toBeInTheDocument();
    expect(code()).toHaveValue('changed outside');
  });

  it('reloads only the file that changed outside Codemm, keeping other unsaved edits', async () => {
    const { user, api, course } = await open();
    const activity = await api.activity(course.topics[0].id);
    await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
    await user.type(screen.getByRole('textbox', { name: 'App.jsx' }), ' // mine');
    await user.click(screen.getByRole('tab', { name: 'Counter.jsx' }));
    await api.saveFile(activity.id, 'Counter.jsx', 'changed outside', activity.files[0].digest);
    await user.type(code(), 'x');
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await within(screen.getByRole('log')).findByText('This file changed outside Codemm, so it was reloaded.');
    expect(code()).toHaveValue('changed outside');
    await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
    expect((screen.getByRole('textbox', { name: 'App.jsx' }) as HTMLTextAreaElement).value).toContain(' // mine');
    expect((await api.activity(course.topics[0].id)).files[1].text).toContain(' // mine');
  });

  it('keeps saving after a save fails once', async () => {
    const { user, api } = await open();
    const saveFile = api.saveFile;
    let failures = 1;
    api.saveFile = (...args) => (failures-- > 0 ? Promise.reject(new Error('disk hiccup')) : saveFile(...args));
    await write(user, 'first');
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await within(results()).findByRole('heading', { name: /visible tests passed/ });
    expect((await api.activity('javascript-basics')).files[0].text).toBe('first');
  });

  it('retries Try it, not Check, after Docker stops', async () => {
    const { user, api } = await open({ docker: 'stopped' });
    let checks = 0;
    const check = api.check;
    api.check = (id) => (checks++, check(id));
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await user.click(await within(results()).findByRole('button', { name: 'Try again' }));
    await within(results()).findByRole('heading', { name: "This check wasn't counted" });
    expect(checks).toBe(0);
  });

  it('keeps practice mode: Codemm explains, the learner writes the code', async () => {
    const { user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Just fix it for me.{Enter}');
    expect(await within(screen.getByRole('log')).findByText(/In practice mode, you write the code\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    expect(await within(screen.getByRole('log')).findByText('Give me a hint.')).toBeInTheDocument();
  });

  it('asks Codemm only after the latest code is saved, and not at all if the save fails', async () => {
    const { api, user } = await open();
    const saveFile = api.saveFile;
    const saves: { text: string; finish: (ok: boolean) => void }[] = [];
    api.saveFile = (id, path, text, digest) =>
      new Promise((done, failed) => saves.push({ text, finish: (ok) => (ok ? done(saveFile(id, path, text, digest)) : failed(new Error('disk full'))) }));
    const asked: string[] = [];
    const ask = api.ask;
    api.ask = (place, text) => (asked.push(text), ask(place, text));

    await write(user, 'count + 1');
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    await vi.waitFor(() => expect(saves.map((s) => s.text)).toEqual(['count + 1']));
    expect(asked).toEqual([]); // still saving: Codemm hasn't been asked
    saves[0].finish(true);
    await vi.waitFor(() => expect(asked).toEqual(['Give me a hint.']));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Hint' })).toBeEnabled());

    await write(user, 'count + 2');
    await user.click(screen.getByRole('button', { name: 'Show me' }));
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    saves[1].finish(false);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(asked).toEqual(['Give me a hint.']); // the failed save kept the question back
    expect(screen.getByRole('button', { name: 'Show me' })).toBeEnabled();
  });

  it('shows quiet progress while a check runs: the phase and "3 of 8"', async () => {
    const { api, user } = await open();
    let send!: (p: { run?: string; phase: 'building' | 'visible' | 'hidden'; done: number; total: number }) => void;
    api.onCheckProgress = (listener) => ((send = listener), () => undefined);
    let finish!: () => void;
    let run: string | undefined;
    const check = api.check;
    api.check = (id, r) => ((run = r), new Promise((done) => (finish = () => done(check(id)))));
    await write(user, 'count + 1');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(run).toEqual(expect.any(String));
    act(() => send({ run, phase: 'visible', done: 3, total: 8 }));
    const bar = within(results()).getByRole('progressbar', { name: 'Visible tests' });
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '8');
    expect(results()).toHaveTextContent('3 of 8');
    // Another run's progress (an earlier check still finishing) never moves this bar.
    act(() => send({ run: 'an-older-run', phase: 'visible', done: 7, total: 8 }));
    expect(results()).toHaveTextContent('3 of 8');
    act(() => send({ run, phase: 'hidden', done: 0, total: 0 }));
    expect(within(results()).getByRole('progressbar', { name: 'Hidden tests' })).not.toHaveAttribute('aria-valuenow');
    finish();
    await within(results()).findByRole('heading', { name: '4 of 4 passed' });
    expect(within(results()).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('stops hearing progress when the learner leaves during a check', async () => {
    const { api, user, unmount } = await open();
    let listening = 0;
    api.onCheckProgress = () => (listening++, () => void listening--);
    api.check = () => new Promise(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(() => expect(listening).toBe(1));
    unmount();
    expect(listening).toBe(0);
  });

  it('takes one question at a time: asking is off while Codemm answers', async () => {
    const { api, user } = await open();
    let answer!: () => void;
    let asked = 0;
    const ask = api.ask;
    api.ask = (place, text) => (asked++, new Promise((done) => (answer = () => done(ask(place, text)))));
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    await vi.waitFor(() => expect(asked).toBe(1));
    expect(screen.getByRole('button', { name: 'Hint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show me' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'And now?{Enter}');
    expect(asked).toBe(1);
    answer();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(asked).toBe(2);
  });

  it('offers calm ways forward when stuck, including an easier topic', async () => {
    const { user } = await open();
    await checkUntilStuck(user);
    expect(within(results()).getByRole('heading', { name: 'Try another way' })).toBeInTheDocument();
    await user.click(within(results()).getByRole('button', { name: 'Keep trying' }));
    expect(within(results()).getByRole('heading', { name: '2 of 4 passed' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await within(results()).findByRole('button', { name: 'Try an easier one' }));
    const map = await screen.findByRole('list', { name: 'Topics' });
    expect(within(map).getByText('JavaScript basics: first steps')).toBeInTheDocument();
  });

  it('comes back later without changing mastery', async () => {
    const { user } = await open();
    await checkUntilStuck(user);
    await user.click(within(results()).getByRole('button', { name: 'Come back later' }));
    const items = within(await screen.findByRole('list', { name: 'Topics' })).getAllByRole('listitem');
    expect(within(items[0]).getByRole('img', { name: 'Later' })).toBeInTheDocument();
    expect(within(items.find((i) => i.textContent?.includes('Lists and keys'))!).getByRole('img', { name: 'Now' })).toBeInTheDocument();
  });

  it('keeps the work when Docker stops mid-session, and counts nothing', async () => {
    const { user } = await open(scenario('docker-stops'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await within(results()).findByRole('heading', { name: '2 of 4 passed' });
    await write(user, 'mine');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: "This check wasn't counted" })).toBeInTheDocument();
    expect(code()).toHaveValue('mine');
    expect(within(screen.getByRole('log')).getByText('Your code is saved. Nothing was recorded.')).toBeInTheDocument();
    expect(within(results()).getByRole('button', { name: 'Check this computer' })).toBeInTheDocument();
  });

  it('sends the learner to sign in again when it expires mid-session, then comes back', async () => {
    const { user } = await open(scenario('sign-in-expires'));
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('Sign in to Claude Code, then try again.');
    await user.click(within(claude).getByRole('button', { name: 'Try again' }));
    await within(claude).findByText('Connected');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });

  it('says when the agent plan limit is reached, and records nothing', async () => {
    const { user } = await open(scenario('plan-limit'));
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your agent's plan limit is reached. Try again later.");
    expect(screen.getByRole('heading', { name: 'Click Counter' })).toBeInTheDocument();
  });
});

describe('Run', () => {
  async function openIo(options?: Parameters<typeof mockWithCourse>[0], strict = false) {
    const { api, course } = await mockWithCourse({ read: true, style: 'io', ...options });
    const view = renderApp({ to: 'practice', concept: course.topics[0].id }, api, { strict });
    await screen.findByRole('heading', { name: 'Greet by name' });
    return { ...view, api, user: userEvent.setup() };
  }
  const terminal = () => screen.getByRole('region', { name: 'Terminal for Greet by name' });
  const mirror = () => screen.getByRole('log', { name: 'Terminal for Greet by name, as text' });

  it('runs the program in the terminal: the command, its output and typed input, then how it ended, recording nothing', async () => {
    const { api, user } = await openIo();
    const tools = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => ['Run', 'Try it', 'Check'].includes(t ?? ''));
    expect(tools).toEqual(['Run', 'Try it', 'Check']);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror().textContent).toBe("$ python3 main.py\nWhat's your name? "));
    expect(terminal()).toHaveTextContent('2:00 left');
    expect(screen.getByRole('button', { name: 'Try it' })).toBeDisabled();
    act(() => xterm.type('Ada\r'));
    await vi.waitFor(() => expect(mirror().textContent).toBe("$ python3 main.py\nWhat's your name? Ada\nHello, Ada!\nExited with code 0.\n"));
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(terminal()).not.toHaveTextContent('left');
    expect((await api.course())!.topics[0].mastery).toBe(0);
  });

  it('runs under StrictMode, as the app does, where every effect replays once', async () => {
    const { user } = await openIo(undefined, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror().textContent).toBe("$ python3 main.py\nWhat's your name? "));
    act(() => xterm.type('Ada\r'));
    await vi.waitFor(() => expect(mirror()).toHaveTextContent('Exited with code 0.'));
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it("says when the time is up, in the header and the terminal", async () => {
    const { user } = await openIo({ runLimitMs: 50 });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror()).toHaveTextContent("Time's up. The program was stopped after 1 second."));
    expect(terminal()).toHaveTextContent("Time's up");
  });

  it('stops the program with Stop, and when the learner leaves', async () => {
    const { api, user, unmount } = await openIo();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/Stopped\.\n$/));
    const stopped: string[] = [];
    const stop = api.stopRun;
    api.stopRun = (run) => (stopped.push(run), stop(run));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('button', { name: 'Stop' });
    unmount();
    expect(stopped).toHaveLength(1);
  });

  it('never starts the program when Stop or leaving comes while the code saves', async () => {
    const { api, user, unmount } = await openIo();
    const saves: (() => void)[] = [];
    const saveFile = api.saveFile;
    api.saveFile = (id, path, text, digest) => new Promise((done) => saves.push(() => done(saveFile(id, path, text, digest))));
    const started: string[] = [];
    const runProgram = api.runProgram;
    api.runProgram = (id, run) => (started.push(run), runProgram(id, run));
    const editor = screen.getByRole('textbox', { name: 'main.py' });
    await user.type(editor, 'x');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    saves[0]();
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/Stopped\.\n$/));
    expect(started).toEqual([]);

    await user.type(editor, 'y');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    unmount();
    saves.slice(1).forEach((finish) => finish());
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([]);
  });

  it('takes typing only once the program has started, and says when a line wasn\'t taken', async () => {
    const { api, user } = await openIo();
    const sent: string[] = [];
    const runProgram = api.runProgram;
    let release!: () => void;
    api.runProgram = () => new Promise((done) => (release = () => done({ kind: 'ran', exit: 137, timedOut: false, stopped: true, flooded: false, outOfMemory: false })));
    api.sendRunInput = async (_run, text) => (sent.push(text), false);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('button', { name: 'Stop' });
    act(() => xterm.type('early\r'));
    expect(sent).toEqual([]);

    api.runProgram = runProgram;
    act(() => release());
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror()).toHaveTextContent("What's your name?"));
    act(() => xterm.type('Ada\r'));
    await vi.waitFor(() => expect(mirror()).toHaveTextContent("That line wasn't taken: the program isn't reading more input."));
    expect(sent).toEqual(['Ada\n']);
  });

  it("says why a program couldn't run", async () => {
    const { api, user } = await openIo();
    api.runProgram = async () => ({ kind: 'not-run', reason: "Docker isn't running." });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror()).toHaveTextContent("Docker isn't running."));
  });

  it('Try it prints each visible test as it finishes: the command, the output, then expected and found', async () => {
    const { user } = await openIo();
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/visible tests passed\n$/));
    expect(mirror().textContent).toBe(
      [
        '$ python3 main.py  (test 01)',
        'Hello, !',
        '✗ test 01',
        '  expected  Hello, Ada!',
        '  found     Hello, !',
        '$ python3 main.py  (test 02)',
        'Hello, !',
        '✗ test 02',
        '  expected  Hello, Grace!',
        '  found     Hello, !',
        '✗ 0 of 2 visible tests passed',
        '',
      ].join('\n'),
    );
    // The structured results stay.
    expect(await within(results()).findByRole('heading', { name: '0 of 2 visible tests passed' })).toBeInTheDocument();
  });

  it('prints a visible test whose event came too late from the final result, once', async () => {
    const { api, user } = await openIo();
    api.onCheckProgress = () => () => undefined; // every event lands after the reply
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/visible tests passed\n$/));
    expect(mirror().textContent!.match(/\(test 01\)/g)).toHaveLength(1);
    expect(mirror().textContent).toContain('$ python3 main.py  (test 02)\nHello, !\n✗ test 02\n');
  });

  it('Check prints visible tests as they finish and hidden tests as an index and a status only', async () => {
    const { user } = await openIo();
    const editor = screen.getByRole('textbox', { name: 'main.py' }) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, 'name = input("What\'s your name? "){Enter}print(f"Hello, {{name}!")');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/of 4 passed\n$/));
    expect(mirror().textContent).toBe(
      ['$ python3 main.py  (test 01)', 'Hello, Ada!', '✓ test 01', '$ python3 main.py  (test 02)', 'Hello, Grace!', '✓ test 02', 'hidden #1 ✓', 'hidden #2 ✓', '✓ 4 of 4 passed', ''].join('\n'),
    );
  });

  it('never lets a test report take the pane from a running program, even through Try again', async () => {
    const { api, user } = await openIo();
    api.tryIt = async () => ({ kind: 'not-counted', reason: "Docker isn't running." });
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await within(results()).findByRole('button', { name: /try again/i });
    const tries: string[] = [];
    api.tryIt = async (id) => (tries.push(id), { kind: 'ran', passed: 0, total: 0, tests: [] });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(mirror().textContent).toContain("What's your name? "));
    await user.click(within(results()).getByRole('button', { name: /try again/i }));
    expect(tries).toEqual([]);
    expect(mirror().textContent).toContain("What's your name? ");
  });

  it("shows a Run's time-up only while the pane holds that Run", async () => {
    const { user } = await openIo({ runLimitMs: 50 });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await vi.waitFor(() => expect(terminal()).toHaveTextContent("Time's up"));
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    await vi.waitFor(() => expect(mirror().textContent).toMatch(/visible tests passed\n$/));
    expect(terminal()).not.toHaveTextContent("Time's up");
  });

  it('has no Run for a unit activity', async () => {
    await open();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });
});
