import { useCallback, useEffect, useState } from 'react';

/** How often screens re-read Codemm while it is still working. */
export const timing = { pollMs: 500 };

interface Loaded<T> {
  data?: T;
  error?: unknown;
  reload: () => void;
}

/** Loads data for a screen, and keeps reloading until `settled` says it is done. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], settled?: (data: T) => boolean): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown }>({});
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    load().then(
      (data) => {
        if (!live) return;
        setState({ data });
        if (settled && !settled(data)) timer = setTimeout(reload, timing.pollMs);
      },
      (error) => live && setState({ error }),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [...deps, tick]);

  return { ...state, reload };
}
