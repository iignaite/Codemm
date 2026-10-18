import { useCallback, useRef, useState } from 'react';

/**
 * One action at a time: `busy` is true while it runs (disable its button), and `guard` ignores a second start
 * until the first ends, so a double click runs it once.
 */
export function useBusy() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const guard = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, guard };
}
