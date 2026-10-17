import { useCallback, useEffect, useState } from 'react';

/** How often screens re-read Codemm while it is still working, re-check this computer, and re-read a settled course. */
export const timing = { pollMs: 500, recheckMs: 5000, idleMs: 600_000 };

interface Loaded<T> {
  data?: T;
  error?: unknown;
  /** True while a read is in flight. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data for a screen, and keeps reloading every `every` ms until `settled` says it is done. With `onFocus`,
 * it also reloads when the window regains focus, and every `timing.idleMs` once settled: time alone can change a
 * course (a review comes due, core §7).
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], settled?: (data: T) => boolean, every = timing.pollMs, onFocus = false): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    load().then(
      (data) => {
        if (!live) return;
        setState({ data, loading: false });
        if (settled && !settled(data)) timer = setTimeout(reload, every);
        else if (onFocus) timer = setTimeout(reload, timing.idleMs);
      },
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [...deps, tick]);

  useEffect(() => {
    if (!onFocus) return;
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [onFocus, reload]);

  return { ...state, reload };
}
