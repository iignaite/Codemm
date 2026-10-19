// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { bringBack, startOnce } from './instance';

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
