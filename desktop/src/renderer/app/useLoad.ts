import { useCallback, useEffect, useState } from 'react';

/** How often screens re-read Codemm while it is still working, and re-check this computer. */
export const timing = { pollMs: 500, recheckMs: 3000 };

interface Loaded<T> {
  data?: T;
  error?: unknown;
  reload: () => void;
}

/** Loads data for a screen, and keeps reloading every `every` ms until `settled` says it is done. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], settled?: (data: T) => boolean, every = timing.pollMs): Loaded<T> {
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
        if (settled && !settled(data)) timer = setTimeout(reload, every);
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
