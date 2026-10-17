import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Graded } from '../../../shared/api';
import { createMockApi } from '../../../main/mock';
import { readyCourse, renderWith } from '../../test/render';
import { Practice } from './Practice';
import { Results } from './Results';

const notYet: Graded = {
  kind: 'graded', passed: 2, total: 4, recorded: true, mastered: false, stuck: false,
  visible: [
    { name: 'Shows Count: 0', passed: true },
    { name: 'Adds one per click', passed: false, expected: 'Count: 1', found: 'Count: 0' },
  ],
  hidden: ['passed', 'failed'],
};
const handlers = { topic: 'State', onRetry: vi.fn(), onContinue: vi.fn(), onLesson: vi.fn(), onEasier: vi.fn(), onLater: vi.fn(), onDismiss: vi.fn() };

describe('Results', () => {
  it('starts quiet and live', () => {
    render(<Results state={{ kind: 'idle' }} {...handlers} />);
    const region = screen.getByRole('region', { name: 'Results' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(within(region).getByText('Only Check is graded.')).toBeTruthy();
  });

  it('shows expected next to found, and hidden tests by index and status only', () => {
    render(<Results state={notYet} {...handlers} />);
    expect(screen.getByRole('heading', { name: '2 of 4 passed' })).toBeTruthy();
    expect(screen.getByText('expected Count: 1')).toBeTruthy();
    expect(screen.getByText('found Count: 0')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Hidden test 1 passed' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Hidden test 2 not yet' })).toBeTruthy();
    expect(screen.getByText('graded, not shown')).toBeTruthy();
  });

  it('says when a check was not counted', () => {
    render(<Results state={{ ...notYet, recorded: false }} {...handlers} />);
    expect(screen.getByText('Not counted. Change the code first.')).toBeTruthy();
  });

  it('celebrates a pass and says the progress in words', async () => {
    render(<Results state={{ ...notYet, passed: 4, hidden: ['passed', 'passed'], mastered: false }} {...handlers} />);
    expect(screen.getByRole('heading', { name: '4 of 4 passed' })).toBeTruthy();
    expect(screen.getByText('Keep going to master State.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(handlers.onContinue).toHaveBeenCalled();
  });

  it('offers calm ways forward when stuck', async () => {
    render(<Results state={{ ...notYet, stuck: true }} {...handlers} />);
    expect(screen.getByRole('heading', { name: 'Try another way' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try an easier one' }));
    expect(handlers.onEasier).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reread the lesson' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Come back later' })).toBeTruthy();
  });

  it('records nothing when the sandbox is down, and says so', () => {
    render(<Results state={{ kind: 'infra', problem: "Docker isn't running. Start it, then try again." }} {...handlers} />);
    expect(screen.getByRole('heading', { name: "This check wasn't counted" })).toBeTruthy();
    expect(screen.getByText("Docker isn't running. Start it, then try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Practice', () => {
  async function open() {
    const api = createMockApi({ delayMs: 0 });
    const course = await readyCourse(api, { read: true });
    const exerciseId = course.topics[0].activity!;
    const r = renderWith(<Practice exerciseId={exerciseId} />, { api, courseId: course.id });
    await screen.findByRole('heading', { name: 'Click Counter' });
    return { ...r, course, exerciseId };
  }
  const editor = () => screen.getByRole('textbox', { name: 'Counter.jsx' }) as HTMLTextAreaElement;

  it('grades only on Check: not counted, not yet, then passed', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Not counted. Change the code first.')).toBeTruthy();
    await user.type(editor(), ' ');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('heading', { name: '2 of 4 passed' })).toBeTruthy();
    expect(within(screen.getByRole('log')).getByLabelText('Line 7')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('heading', { name: '4 of 4 passed' })).toBeTruthy();
  });

  it('Try it runs visible tests only', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByText('Not graded')).toBeTruthy();
    expect(screen.queryByText('Hidden tests')).toBeNull();
  });

  it('switches between files', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('tab', { name: 'App.jsx' }));
    expect(screen.getByRole('textbox', { name: 'App.jsx' })).toBeTruthy();
  });

  it('asks before Codemm may edit', async () => {
    const { user, api } = await open();
    const setAssist = vi.spyOn(api, 'setAssist');
    const sw = screen.getByRole('switch', { name: 'Assist' });
    await user.click(sw);
    expect(screen.getByRole('dialog', { name: 'Let Codemm edit this activity?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep trying' }));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Show me' }));
    await user.click(screen.getByRole('button', { name: 'Let Codemm edit' }));
    expect(setAssist).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await user.click(sw);
    expect(setAssist).toHaveBeenLastCalledWith(false);
  });

  it('keeps the learner writing the code', async () => {
    const { user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Just fix it for me.{Enter}');
    const log = screen.getByRole('log');
    expect(await within(log).findByText('In practice mode, you write the code.')).toBeTruthy();
    expect(within(log).getByText('Just fix it for me.')).toBeTruthy();
  });

  it('gives a hint on request', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Hint' }));
    expect(await within(screen.getByRole('log')).findByLabelText('Line 7')).toBeTruthy();
  });
});
