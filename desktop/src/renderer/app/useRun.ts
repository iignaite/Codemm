import { useEffect, useRef, useState, type RefObject } from 'react';
import type { RunResult } from '../../shared/api';
import type { TerminalHandle } from '../ui/Terminal';
import { useApi } from './api';

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
 * Run (§4.10): a program in the terminal pane, with typed input, counting down its time limit: the learner's
 * (runProgram) or a lesson example (runExampleLive), which `begin` starts. Never recorded. Only this run's output is
 * shown, and leaving the screen stops it. `command`, when known, heads the output; `save` runs first (the learner's
 * pending edits).
 */
export interface RunOptions {
  begin: (run: string) => Promise<RunResult>;
  terminal: RefObject<TerminalHandle | null>;
  fail: (e: unknown) => void;
  command?: string;
  save?: () => Promise<void>;
}

export function useRun({ begin, terminal, fail, command, save = async () => undefined }: RunOptions) {
  const api = useApi();
  const [run, setRun] = useState<string>();
  // Input is on once the program has started: before that, main has nothing to send it to.
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<string>();
  const [deadline, setDeadline] = useState<number>();
  const [now, setNow] = useState(Date.now);
  /** This screen's run: Stop and leaving mark it, so a run still saving never starts. */
  const current = useRef<{ id: string; cancelled: boolean; off: () => void }>(undefined);
  const left = useRef(false);

  // The countdown, once a second while the program runs.
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  // Leaving stops it and stops listening. Set up again on every mount: StrictMode replays effects.
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
      const c = current.current;
      if (!c) return;
      c.cancelled = true;
      c.off();
      void api.stopRun(c.id).catch(() => undefined);
    };
  }, [api]);

  async function start() {
    const id = crypto.randomUUID();
    const limits = { build: 0, run: 0 };
    const off = api.onRunOutput((o) => {
      if (o.run !== id) return;
      if ('started' in o) {
        limits[o.started] = o.limitMs;
        setReady(true);
        setStatus(o.started === 'build' ? 'Building' : undefined);
        // One reading of the clock: two could straddle a millisecond and show a second too many.
        const at = Date.now();
        setNow(at);
        setDeadline(o.started === 'run' ? at + o.limitMs : undefined);
      } else terminal.current?.write(o.text, o.stream);
    });
    const session = { id, cancelled: false, off };
    current.current = session;
    setRun(id);
    setStatus(undefined);
    try {
      await save();
      if (left.current) return;
      if (session.cancelled) {
        terminal.current?.line('Stopped.', 'quiet');
        return;
      }
      terminal.current?.clear();
      if (command) terminal.current?.command(command);
      terminal.current?.focus();
      const result = await begin(id);
      if (left.current) return;
      const [text, tone] = ending(result, limits);
      terminal.current?.line(text, tone);
      setStatus(result.kind === 'ran' && result.timedOut ? "Time's up" : undefined);
    } catch (e) {
      if (!left.current) fail(e);
    } finally {
      off();
      if (current.current === session) current.current = undefined;
      if (!left.current) {
        setDeadline(undefined);
        setReady(false);
        setRun(undefined);
      }
    }
  }

  function stop() {
    const c = current.current;
    if (!c) return;
    c.cancelled = true;
    void api.stopRun(c.id).catch(fail);
  }

  async function send(text: string) {
    const c = current.current;
    if (!c) return;
    try {
      // False: the program ended, or it has too much unread input already.
      if (!(await api.sendRunInput(c.id, text)) && current.current === c) terminal.current?.line("That line wasn't taken: the program isn't reading more input.", 'fail');
    } catch (e) {
      fail(e);
    }
  }

  return {
    running: run !== undefined,
    status: deadline !== undefined ? `${clock(deadline - now)} left` : status,
    start,
    stop,
    input: run && ready ? (text: string) => void send(text) : undefined,
  };
}
