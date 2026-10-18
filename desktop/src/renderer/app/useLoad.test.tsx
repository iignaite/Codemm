import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLoad } from './useLoad';

/** A load the test answers by hand, counting reads. */
function manual<T>() {
  const pending: { ok: (v: T) => void; no: (e: unknown) => void }[] = [];
  const load = () => new Promise<T>((ok, no) => pending.push({ ok, no }));
  return { load, pending };
}

describe('useLoad', () => {
  it('takes its options as an object: it polls until settled', async () => {
    let n = 0;
    const { result } = renderHook(() => useLoad(async () => ++n, [], { settled: (v) => v >= 3, every: 5 }));
    await waitFor(() => expect(result.current.data).toBe(3));
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(3);
  });

  it('shows an error when nothing has loaded yet', async () => {
    const { result } = renderHook(() => useLoad(() => Promise.reject(new Error('offline')), []));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.data).toBeUndefined();
    expect(result.current.stale).toBeUndefined();
  });

  it('keeps the last data when a later read fails, says so as stale, and clears it on the next success', async () => {
    const m = manual<string>();
    const { result } = renderHook(() => useLoad(m.load, []));
    await waitFor(() => expect(m.pending).toHaveLength(1));
    await act(async () => m.pending[0].ok('first'));
    act(() => result.current.reload());
    await waitFor(() => expect(m.pending).toHaveLength(2));
    await act(async () => m.pending[1].no(new Error('offline')));
    expect(result.current.data).toBe('first');
    expect(result.current.error).toBeUndefined();
    expect(result.current.stale).toBeInstanceOf(Error);
    act(() => result.current.reload());
    await waitFor(() => expect(m.pending).toHaveLength(3));
    await act(async () => m.pending[2].ok('second'));
    expect(result.current.data).toBe('second');
    expect(result.current.stale).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it("never overlaps reads: a reload while one runs waits, then reads once more", async () => {
    const m = manual<number>();
    const { result } = renderHook(() => useLoad(m.load, []));
    await waitFor(() => expect(m.pending).toHaveLength(1));
    act(() => {
      result.current.reload();
      result.current.reload();
    });
    expect(m.pending).toHaveLength(1);
    await act(async () => m.pending[0].ok(1));
    await waitFor(() => expect(m.pending).toHaveLength(2));
    await act(async () => m.pending[1].ok(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.pending).toHaveLength(2);
    expect(result.current.data).toBe(2);
  });

  it('starts over at once when its inputs change, whatever is in flight', async () => {
    const m = manual<string>();
    const { result, rerender } = renderHook(({ id }) => useLoad(m.load, [id]), { initialProps: { id: 'a' } });
    await waitFor(() => expect(m.pending).toHaveLength(1));
    rerender({ id: 'b' });
    await waitFor(() => expect(m.pending).toHaveLength(2));
    await act(async () => m.pending[0].ok('old'));
    await act(async () => m.pending[1].ok('new'));
    expect(result.current.data).toBe('new');
  });
});
