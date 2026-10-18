// The exercise gate core writes while an author job's save runs (`codemm mcp --progress`, DESIGN §4.11).
// Main reads only the gate's name from it: nothing else in the file is kept or forwarded.
import { readFileSync, rmSync, statSync } from 'node:fs';
import { GATES, type Gate } from './progress';

/** The gate the file names, or undefined for anything else: no file, a damaged one, or an unknown gate. */
export function readGate(path: string): Gate | undefined {
  try {
    if (statSync(path).size > 1024) return undefined;
    const v = JSON.parse(readFileSync(path, 'utf8')) as { format_version?: unknown; gate?: unknown };
    return v?.format_version === 1 && typeof v.gate === 'string' && Object.hasOwn(GATES, v.gate) ? (v.gate as Gate) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the file every `everyMs` while the job runs. `clear` forgets a finished save's gate; `stop` ends it and removes the file. */
export function watchGates(path: string, onGate: (gate: Gate) => void, everyMs = 500) {
  const timer = setInterval(() => {
    const gate = readGate(path);
    if (gate) onGate(gate);
  }, everyMs);
  // Never throws: a file Codemm can't remove (Windows EPERM) only means a stale gate, which the tracker ignores.
  const clear = () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // left for the next clear
    }
  };
  return {
    clear,
    stop() {
      clearInterval(timer);
      clear();
    },
  };
}
