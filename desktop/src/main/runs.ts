// Run binds each program to the window that started it (§4.10): only that window hears its output, types
// into it or stops it, and closing the window stops it.
import { SafeError } from './errors';

type Handle<E> = (event: E, method: unknown, args: unknown) => Promise<unknown>;

export function bindRuns<W>() {
  const owners = new Map<string, W>();
  return {
    /** Wraps the IPC handler. A Run belongs to its window from the start call until that call settles. */
    wrap<E extends { sender: W }>(handle: Handle<E>): Handle<E> {
      return (event, method, args) => {
        if (method === 'runProgram' && Array.isArray(args)) {
          const run = args[1];
          if (typeof run !== 'string' || owners.has(run)) return Promise.reject(new SafeError('Bad input'));
          owners.set(run, event.sender);
          return handle(event, method, args).finally(() => owners.delete(run));
        }
        // Another window's Run, or one that ended: nothing happens, as for input that came too late.
        if ((method === 'sendRunInput' || method === 'stopRun') && Array.isArray(args) && owners.get(args[0]) !== event.sender) {
          return Promise.resolve(method === 'sendRunInput' ? false : undefined);
        }
        return handle(event, method, args);
      };
    },
    ownerOf: (run: string): W | undefined => owners.get(run),
    runsOf: (window: W): string[] => [...owners].filter(([, w]) => w === window).map(([run]) => run),
  };
}
