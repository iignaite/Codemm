import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Activity } from '../../../shared/api';
import { useApi } from '../../app/api';
import type { TerminalHandle } from '../../ui/Terminal';
import { printCheck, printTest, printTry } from './paneReport';
import type { Shown } from './Results';

interface AttemptOptions {
  activity: Activity;
  terminal: RefObject<TerminalHandle | null>;
  /** The learner's pending edits, saved before each attempt. */
  save: () => Promise<void>;
  fail: (e: unknown) => void;
  /** True while a program runs: it owns the pane, so no attempt starts. */
  blocked: () => boolean;
  /** An attempt starts: the pane shows its tests. */
  onStart: () => void;
}

/**
 * Try it and Check (§4.8): what Results shows, and one attempt at a time. While the tests run, only this attempt's
 * progress is heard, and none after leaving the screen; an io activity also prints each visible test into the
 * terminal as it finishes, then the summary.
 */
export function useAttempt({ activity, terminal, save, fail, blocked, onStart }: AttemptOptions) {
  const api = useApi();
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const listening = useRef<() => void>(undefined);
  useEffect(() => () => listening.current?.(), []);

  async function attempt(label: string, work: (run: string) => Promise<Shown>) {
    if (blocked()) return;
    onStart();
    const before = shown;
    const run = crypto.randomUUID();
    setShown({ kind: 'busy', label });
    listening.current?.();
    const command = activity.run;
    const streamed = new Set<string>();
    const stop = api.onCheckProgress((progress) => {
      if (progress.run !== run) return;
      setShown((s) => (s.kind === 'busy' ? { ...s, progress } : s));
      if (command && progress.test && terminal.current) {
        streamed.add(progress.test.name);
        printTest(terminal.current, command, progress.test, activity.visibleTests);
      }
    });
    listening.current = stop;
    try {
      await save();
      terminal.current?.clear();
      const result = await work(run);
      if (command && terminal.current) {
        if (result.kind === 'try') printTry(terminal.current, command, result.result, streamed, activity.visibleTests);
        if (result.kind === 'check') printCheck(terminal.current, command, result.result, streamed, activity.visibleTests);
      }
      setShown(result);
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
