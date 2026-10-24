import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How often screens re-read Codemm while it is still working, re-check this computer, look for agents (one installed,
 * removed or signed in elsewhere), and re-read a settled course.
 */
export const timing = { pollMs: 500, recheckMs: 5000, agentsMs: 3000, idleMs: 600_000 };

export interface LoadOptions<T> {
  /** Keep re-reading every `every` ms until this says the data is done. */
  settled?: (data: T) => boolean;
  every?: number;
  /** Also re-read when the window regains focus, and every `timing.idleMs` once settled: time alone can change a course (a review comes due, core §7). */
  onFocus?: boolean;
  /** Once settled, re-read every `idle` ms instead. */
  idle?: number;
}

interface Loaded<T> {
  data?: T;
  /** A read failed and nothing has loaded for these inputs: the screen shows Failed. */
  error?: unknown;
  /** A read failed after one for the same inputs succeeded: that data stays, and the screen says it couldn't refresh. */
  stale?: unknown;
  /** True while a read is in flight. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data for a screen. Reads never overlap: a reload while one is in flight waits for it, drops what it read (it
 * began before whatever the reload is for), then reads once more. New inputs (`deps`) start over at once.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], { settled, every = timing.pollMs, onFocus = false, idle }: LoadOptions<T> = {}): Loaded<T> {
  // `gen` counts input changes, not reloads: the data's own `gen` says which inputs it came from.
  const [state, setState] = useState<{ data?: T; gen?: number; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const reading = useRef(false);
  const again = useRef(false);
  const reload = useCallback(() => {
    if (reading.current) again.current = true;
    else setTick((t) => t + 1);
  }, []);

  // Declared first, so it runs before the read below.
  useEffect(() => {
    gen.current += 1;
  }, deps);

  useEffect(() => {
    let live = true;
    const at = gen.current;
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
        if (!again.current) setState({ data, gen: at, loading: false });
        done(() => {
          const after = settled && !settled(data) ? every : (idle ?? (onFocus ? timing.idleMs : undefined));
          if (after !== undefined) timer = setTimeout(reload, after);
        });
      },
      (error) => {
        if (!live) return;
        // The last data stays when it came from these inputs: one failed read doesn't take the screen away.
        // Data from other inputs never stands in for these.
        if (!again.current) setState((s) => (s.gen === at ? { data: s.data, gen: at, error, loading: false } : { error, loading: false }));
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
