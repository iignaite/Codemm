import { useCallback, useEffect, useRef, useState } from 'react';

/** How often screens re-read Codemm while it is still working, re-check this computer, and re-read a settled course. */
export const timing = { pollMs: 500, recheckMs: 5000, idleMs: 600_000 };

export interface LoadOptions<T> {
  /** Keep re-reading every `every` ms until this says the data is done. */
  settled?: (data: T) => boolean;
  every?: number;
  /** Also re-read when the window regains focus, and every `timing.idleMs` once settled: time alone can change a course (a review comes due, core §7). */
  onFocus?: boolean;
}

interface Loaded<T> {
  data?: T;
  /** A read failed and there is nothing to show yet: the screen shows Failed. */
  error?: unknown;
  /** A read failed after one succeeded: the last data stays, and the screen says it couldn't refresh. */
  stale?: unknown;
  /** True while a read is in flight. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data for a screen. Reads never overlap: a reload while one is in flight waits for it, then reads once more.
 * New inputs (`deps`) start over at once.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], { settled, every = timing.pollMs, onFocus = false }: LoadOptions<T> = {}): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const reading = useRef(false);
  const again = useRef(false);
  const reload = useCallback(() => {
    if (reading.current) again.current = true;
    else setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    reading.current = true;
    again.current = false;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    /** A reload asked for meanwhile reads once more, now; otherwise `next` decides. */
    const done = (next: () => void) => {
      reading.current = false;
      if (again.current) {
        again.current = false;
        setTick((t) => t + 1);
      } else next();
    };
    load().then(
      (data) => {
        if (!live) return;
        setState({ data, loading: false });
        done(() => {
          if (settled && !settled(data)) timer = setTimeout(reload, every);
          else if (onFocus) timer = setTimeout(reload, timing.idleMs);
        });
      },
      (error) => {
        if (!live) return;
        // The last data stays: one failed read doesn't take the screen away.
        setState((s) => ({ data: s.data, error, loading: false }));
        done(() => undefined);
      },
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

  const { data, error, loading } = state;
  return { data, loading, reload, ...(error === undefined ? {} : data === undefined ? { error } : { stale: error }) };
}
