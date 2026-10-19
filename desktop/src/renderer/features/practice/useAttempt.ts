import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api';
import type { Shown } from './Results';

interface AttemptOptions {
  /** The learner's pending edits, saved before each attempt. */
  save: () => Promise<void>;
  fail: (e: unknown) => void;
  /** True while a program runs, so no attempt starts. */
  blocked: () => boolean;
}

/**
 * Try it and Check (§4.8): what Results shows, and one attempt at a time. While the tests run, only this attempt's
 * progress is heard, and none after leaving the screen. Results is the one place test results show; the terminal
 * is Run's (§4.10).
 */
export function useAttempt({ save, fail, blocked }: AttemptOptions) {
  const api = useApi();
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const listening = useRef<() => void>(undefined);
  useEffect(() => () => listening.current?.(), []);

  async function attempt(label: string, work: (run: string) => Promise<Shown>) {
    if (blocked()) return;
    const before = shown;
    const run = crypto.randomUUID();
    setShown({ kind: 'busy', label });
    listening.current?.();
    const stop = api.onCheckProgress((progress) => {
      if (progress.run !== run) return;
      setShown((s) => (s.kind === 'busy' ? { ...s, progress } : s));
    });
    listening.current = stop;
    try {
      await save();
      setShown(await work(run));
    } catch (e) {
      setShown(before);
      fail(e);
    } finally {
      stop();
      if (listening.current === stop) listening.current = undefined;
    }
  }

  return { shown, setShown, attempt };
}
