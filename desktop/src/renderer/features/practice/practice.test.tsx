import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { scenario } from '../../../main/mock';
import { mockWithCourse, renderApp } from '../../test-utils';

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
    await within(results()).findByRole('heading', { name: /passed|Try another way/ });
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

  it('keeps practice mode: Codemm explains, the learner writes the code', async () => {
    const { user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Just fix it for me.{Enter}');
    expect(await within(screen.getByRole('log')).findByText(/In practice mode, you write the code\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    expect(await within(screen.getByRole('log')).findByText('Give me a hint.')).toBeInTheDocument();
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
