// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { bringBack, secondLaunch, startOnce } from './instance';

describe('one Codemm per learner (§2)', () => {
  it('starts Codemm in the first instance', () => {
    const app = { requestSingleInstanceLock: () => true, quit: vi.fn() };
    const start = vi.fn();
    startOnce(app, start);
    expect(start).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits a second instance before it starts anything', () => {
    const app = { requestSingleInstanceLock: () => false, quit: vi.fn() };
    const start = vi.fn();
    startOnce(app, start);
    expect(start).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('gives a second launch the open window, or a new one when none is open', () => {
    const win = { isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const open = vi.fn();
    const relaunch = vi.fn();
    secondLaunch({ quitting: false, updating: false, win, open, relaunch });
    expect(win.focus).toHaveBeenCalled();
    secondLaunch({ quitting: false, updating: false, open, relaunch });
    expect(open).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("opens Codemm again once it has stopped, for a launch while it quits; an update's installer opens it itself", () => {
    const win = { isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const open = vi.fn();
    const relaunch = vi.fn();
    secondLaunch({ quitting: true, updating: false, win, open, relaunch });
    expect(relaunch).toHaveBeenCalledOnce();
    secondLaunch({ quitting: true, updating: true, win, open, relaunch });
    expect(relaunch).toHaveBeenCalledOnce();
    // A window that is about to close is never shown, and none is opened.
    expect(win.focus).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("brings the open window back for a second launch: restored when minimized, shown and in front", () => {
    const calls: string[] = [];
    const win = (minimized: boolean) => ({
      isMinimized: () => minimized,
      restore: () => void calls.push('restore'),
      show: () => void calls.push('show'),
      focus: () => void calls.push('focus'),
    });
    bringBack(win(true));
    expect(calls).toEqual(['restore', 'show', 'focus']);
    calls.length = 0;
    bringBack(win(false));
    expect(calls).toEqual(['show', 'focus']);
  });
});
