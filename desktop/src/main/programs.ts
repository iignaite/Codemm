// Run's programs (DESIGN §4.10), an activity's or a lesson example's, by run id. What they print goes to whoever
// listens (main sends it to the window that started each); input and Stop act on a run by its id.
import type { RunOutput, RunResult } from '../shared/api';
import type { CoreProgramRun } from './core/types';
import { SafeError } from './errors';
import type { Log } from './log';
import { asNotCounted } from './notCounted';

/** Run's programs at once, across windows: each holds a container. */
const MAX_PROGRAMS = 4;

export type StartProgram = (
  output: (text: string, stream: 'stdout' | 'stderr') => void,
  options: { onStart: (stage: 'build' | 'run', limitMs: number) => void },
) => Promise<CoreProgramRun>;

export interface ProgramDeps {
  /** Runs a container operation once Docker isn't starting, tracked so quitting waits for it (live.ts). */
  whenDockerReady<T>(operation: () => Promise<T>): Promise<T>;
  log: Log;
}

interface Entry {
  program?: CoreProgramRun;
  stopped: boolean;
  cancel?: () => void;
}

export function programs({ whenDockerReady, log }: ProgramDeps) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(o: RunOutput) => void>();
  const tell = (o: RunOutput) => listeners.forEach((l) => l(o));

  function stopEntry(entry: Entry) {
    entry.stopped = true;
    entry.cancel?.();
    entry.program?.kill();
  }

  return {
    onOutput(listener: (o: RunOutput) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** One Run: its output tagged with `run`, and stoppable before it has started. */
    async start(run: string, startProgram: StartProgram): Promise<RunResult> {
      if (entries.has(run)) throw new SafeError('Bad input');
      if (entries.size >= MAX_PROGRAMS) throw new SafeError('Too many programs are running. Stop one, then try again.');
      const entry: Entry = { stopped: false };
      entries.set(run, entry);
      try {
        const r = await new Promise<Awaited<CoreProgramRun['done']> | undefined>((resolve, reject) => {
          let starting = false;
          // Stopped while waiting for Docker: it ends now, frees its place, and never starts.
          entry.cancel = () => !starting && resolve(undefined);
          // Tracked until the program has ended, so quitting waits for its container and files to go.
          whenDockerReady(async () => {
            if (entry.stopped) return undefined;
            starting = true;
            const program = await startProgram((text, stream) => tell({ run, stream, text }), { onStart: (stage, limitMs) => tell({ run, started: stage, limitMs }) });
            entry.program = program;
            // Stopped while it was starting.
            if (entry.stopped) program.kill();
            return program.done;
          }).then(resolve, reject);
        });
        if (!r) return { kind: 'ran', exit: 137, timedOut: false, stopped: true, flooded: false, outOfMemory: false };
        return { kind: 'ran', exit: r.exit, ...(r.stage ? { stage: r.stage } : {}), timedOut: r.timedOut, stopped: r.stopped ?? false, flooded: r.flooded, outOfMemory: r.outOfMemory ?? false };
      } catch (e) {
        return asNotCounted(e, log, 'program', 'not-run');
      } finally {
        entries.delete(run);
      }
    },

    input: async (run: string, text: string) => entries.get(run)?.program?.write(text) ?? false,

    async stop(run: string) {
      const entry = entries.get(run);
      if (entry) stopEntry(entry);
    },

    /** Quitting: every program stops. */
    stopAll() {
      for (const entry of entries.values()) stopEntry(entry);
    },
  };
}
