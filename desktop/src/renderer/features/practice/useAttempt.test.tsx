import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CheckProgress, CodemmApi } from '../../../shared/api';
import { createMock } from '../../../main/mock';
import { ApiContext } from '../../app/api';
import { useAttempt } from './useAttempt';

const activity = { id: 'a1', concept: 'c', title: 'T', statement: '', visibleTests: [], files: [] };

function setup(blocked = false) {
  const api = createMock() as CodemmApi;
  let hear: (p: CheckProgress) => void = () => undefined;
  api.onCheckProgress = (l) => ((hear = l), () => undefined);
  const onStart = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
  const { result } = renderHook(() => useAttempt({ activity, terminal: { current: null }, save: async () => undefined, fail: vi.fn(), blocked: () => blocked, onStart }), { wrapper });
  return { result, hear: (p: CheckProgress) => hear(p), onStart };
}

describe('useAttempt', () => {
  it('starts nothing while a program owns the pane', async () => {
    const { result, onStart } = setup(true);
    const work = vi.fn();
    await act(() => result.current.attempt('Checking', work));
    expect(work).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(result.current.shown).toEqual({ kind: 'idle' });
  });

  it("shows only its own run's progress while busy, then the result", async () => {
    const { result, hear } = setup();
    let finish!: () => void;
    let run = '';
    let done!: Promise<void>;
    act(() => {
      done = result.current.attempt('Checking', (r) => ((run = r), new Promise((ok) => (finish = () => ok({ kind: 'idle' })))));
    });
    await vi.waitFor(() => expect(run).not.toBe(''));
    act(() => hear({ run: 'another', phase: 'visible', done: 1, total: 3 }));
    expect(result.current.shown).toEqual({ kind: 'busy', label: 'Checking' });
    act(() => hear({ run, phase: 'visible', done: 2, total: 3 }));
    expect(result.current.shown).toEqual({ kind: 'busy', label: 'Checking', progress: { run, phase: 'visible', done: 2, total: 3 } });
    await act(async () => {
      finish();
      await done;
    });
    expect(result.current.shown).toEqual({ kind: 'idle' });
  });
});
