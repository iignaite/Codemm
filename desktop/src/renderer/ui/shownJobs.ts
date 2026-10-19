// The jobs a bar is on screen for right now (§4.11), so the sidebar shows only the others.
import { useSyncExternalStore } from 'react';

const shown = new Map<string, number>();
const listeners = new Set<() => void>();
let jobs: ReadonlySet<string> = new Set();

function changed() {
  jobs = new Set(shown.keys());
  listeners.forEach((l) => l());
}

/** A bar shows this job until the function this returns is called. Two bars may show one job. */
export function showJob(job: string): () => void {
  shown.set(job, (shown.get(job) ?? 0) + 1);
  changed();
  return () => {
    const left = (shown.get(job) ?? 1) - 1;
    if (left > 0) shown.set(job, left);
    else shown.delete(job);
    changed();
  };
}

/** The jobs some bar shows now. */
export function useShownJobs(): ReadonlySet<string> {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => jobs);
}
