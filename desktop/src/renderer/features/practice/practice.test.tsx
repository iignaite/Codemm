import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockWithCourse, renderApp } from '../../test-utils';

async function open(options?: Parameters<typeof mockWithCourse>[0]) {
  const { api, course } = await mockWithCourse({ read: true, ...options });
  const view = renderApp({ to: 'practice', activityId: course.topics[0].activity.id }, api);
  await screen.findByRole('heading', { name: 'Click Counter' });
  return { ...view, course, user: userEvent.setup() };
}

const results = () => screen.getByRole('region', { name: 'Results' });

describe('practice', () => {
  it('opens the activity with only Check graded', async () => {
    await open();
    expect((screen.getByRole('textbox', { name: 'Counter.jsx' }) as HTMLTextAreaElement).value).toContain('/* your code */');
    expect(results()).toHaveAttribute('aria-live', 'polite');
    expect(results()).toHaveTextContent('Only Check is graded.');
  });

  it('switches files with tabs', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
    expect(screen.getByRole('tab', { name: 'App.jsx' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'App.jsx' })).toBeInTheDocument();
  });

  it('runs without grading', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await within(results()).findByText('Count: 0')).toBeInTheDocument();
  });

  it('shows expected next to found, and hidden tests as statuses only', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: '2 of 4 passed' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('Adds one per click');
    expect(results()).toHaveTextContent('expected Count: 1');
    expect(results()).toHaveTextContent('found Count: 0');
    expect(within(results()).getByRole('img', { name: 'Hidden test 1 passed' })).toBeInTheDocument();
    expect(within(results()).getByRole('img', { name: 'Hidden test 2 not yet' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('graded, not shown');
  });

  it('passes once the learner writes the code, then continues to the course', async () => {
    const { user } = await open();
    const code = screen.getByRole('textbox', { name: 'Counter.jsx' });
    await user.clear(code);
    await user.type(code, 'my answer');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: '4 of 4 passed' })).toBeInTheDocument();
    expect(results()).toHaveTextContent('JavaScript basics mastered.');
    await user.click(within(results()).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'React basics' })).toBeInTheDocument();
  });

  it('keeps practice mode: Codemm points at the line instead of writing the code', async () => {
    const { user, container } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Just fix it for me.{Enter}');
    const log = screen.getByRole('log');
    expect(await within(log).findByText('In practice mode, you write the code.')).toBeInTheDocument();
    expect(within(log).getByLabelText('Line 7')).toBeInTheDocument();
    expect(container.querySelector('.hl')).toHaveStyle({ top: 'calc(6 * 1.8em + 16px)' });
  });

  it('gives a hint and shows the line', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    expect(await within(screen.getByRole('log')).findByText('Look at what you pass to setCount.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show me' }));
    expect(await within(screen.getByRole('log')).findByText('This line sets the next value.')).toBeInTheDocument();
  });

  it('asks before Codemm edits, and changes nothing until the learner says yes', async () => {
    const { user } = await open();
    const assist = screen.getByRole('switch', { name: 'Assist' });
    await user.click(assist);
    expect(screen.getByRole('dialog', { name: 'Let Codemm edit this activity?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep trying' }));
    expect(assist).toHaveAttribute('aria-checked', 'false');

    await user.click(assist);
    await user.click(screen.getByRole('button', { name: 'Let Codemm edit' }));
    expect(await within(results()).findByRole('heading', { name: '4 of 4 passed' })).toBeInTheDocument();
    expect(assist).toHaveAttribute('aria-checked', 'true');
  });

  it('offers calm ways forward when stuck', async () => {
    const { user } = await open();
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByRole('button', { name: 'Check' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check' })).toBeEnabled());
    }
    expect(await within(results()).findByRole('heading', { name: 'Try another way' })).toBeInTheDocument();
    await user.click(within(results()).getByRole('button', { name: 'Keep trying' }));
    expect(within(results()).getByRole('heading', { name: '2 of 4 passed' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await within(results()).findByRole('button', { name: 'Try an easier one' }));
    expect(await screen.findByRole('heading', { name: 'Click Counter, one step' })).toBeInTheDocument();
  });

  it("says when a check wasn't counted, and records nothing", async () => {
    const { user } = await open({ sandbox: false });
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await within(results()).findByRole('heading', { name: "This check wasn't counted" })).toBeInTheDocument();
    expect(results()).toHaveTextContent("Docker isn't running. Start it, then try again.");
    expect(within(screen.getByRole('log')).getByText('Your code is saved. Nothing was recorded.')).toBeInTheDocument();
    expect(within(results()).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
