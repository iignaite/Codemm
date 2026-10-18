import { useEffect, useRef, useState, type RefObject } from 'react';
import type { RunResult } from '../../../shared/api';
import { useApi } from '../../app/api';
import type { TerminalHandle } from '../../ui/Terminal';

/** "2 minutes", "1 minute", "45 seconds", "1 second". */
function duration(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Codemm's last line for a run, and its tone. */
function ending(r: RunResult, limits: Record<'build' | 'run', number>): [string, 'ok' | 'fail' | 'quiet'] {
  if (r.kind === 'not-run') return [r.reason, 'fail'];
  const what = r.stage === 'build' ? 'The build' : 'The program';
  if (r.stopped) return ['Stopped.', 'quiet'];
  if (r.timedOut) return [`Time's up. ${what} was stopped after ${duration(limits[r.stage ?? 'run'])}.`, 'fail'];
  if (r.outOfMemory) return [`${what} ran out of memory.`, 'fail'];
  if (r.flooded) return [`${what} printed too much, so it was stopped.`, 'fail'];
  if (r.stage === 'build') return [`The build failed with code ${r.exit}.`, 'fail'];
  return [`Exited with code ${r.exit}.`, r.exit === 0 ? 'quiet' : 'fail'];
}

/**
 * Run (§4.10): the learner's program in the terminal pane, with typed input, counting down its time limit.
 * Never recorded. Only this run's output is shown, and leaving the screen stops it.
 */
export function useRun(activityId: string, command: string | undefined, terminal: RefObject<TerminalHandle | null>, save: () => Promise<void>, fail: (e: unknown) => void) {
  const api = useApi();
  const [run, setRun] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [deadline, setDeadline] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const current = useRef<string>(undefined);

  // The countdown, once a second while the program runs.
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  // Leaving stops it.
  useEffect(
    () => () => {
      if (current.current) void api.stopRun(current.current).catch(() => undefined);
    },
    [api],
  );

  async function start() {
    const id = crypto.randomUUID();
    const limits = { build: 0, run: 0 };
    current.current = id;
    setRun(id);
    setStatus(undefined);
    const off = api.onRunOutput((o) => {
      if (o.run !== id) return;
      if ('started' in o) {
        limits[o.started] = o.limitMs;
        setStatus(o.started === 'build' ? 'Building' : undefined);
        setNow(Date.now());
        setDeadline(o.started === 'run' ? Date.now() + o.limitMs : undefined);
      } else terminal.current?.write(o.text, o.stream);
    });
    try {
      await save();
      terminal.current?.clear();
      terminal.current?.command(command ?? '');
      terminal.current?.focus();
      const result = await api.runProgram(activityId, id);
      const [text, tone] = ending(result, limits);
      terminal.current?.line(text, tone);
      setStatus(result.kind === 'ran' && result.timedOut ? "Time's up" : undefined);
    } catch (e) {
      fail(e);
    } finally {
      off();
      setDeadline(undefined);
      if (current.current === id) current.current = undefined;
      setRun(undefined);
    }
  }

  return {
    running: run !== undefined,
    status: deadline !== undefined ? `${clock(deadline - now)} left` : status,
    start,
    stop: () => run && void api.stopRun(run).catch(fail),
    input: run ? (text: string) => void api.sendRunInput(run, text).catch(fail) : undefined,
  };
}
