import { useEffect, useState } from 'react';
import type { JobProgress } from '../../shared/api';
import { useApi } from './api';

/** A job's latest progress, and when it arrived here. */
export interface HeardJob {
  progress: JobProgress;
  at: number;
}

/**
 * The progress of every running job that `match` picks (§4.11), in the order they were first heard. A screen that
 * opens while jobs run gets their progress so far, then follows them; an ended job is dropped.
 */
export function useJobs(match: (p: JobProgress) => boolean, deps: unknown[]): HeardJob[] {
  const api = useApi();
  const [heard, setHeard] = useState<HeardJob[]>([]);
  useEffect(() => {
    let live = true;
    setHeard((all) => (all.length ? [] : all));
    /** Jobs an event told about: what jobProgress read is older, and can't bring back one that ended. */
    const told = new Set<string>();
    const take = (p: JobProgress, fresh: boolean) => {
      if (!live || !match(p)) return;
      if (fresh) told.add(p.job);
      else if (told.has(p.job)) return;
      setHeard((all) => {
        const at = all.findIndex((h) => h.progress.job === p.job);
        if (p.ended) return at < 0 ? all : all.filter((_, i) => i !== at);
        if (!fresh && at >= 0) return all;
        const next = { progress: p, at: Date.now() };
        return at < 0 ? [...all, next] : all.map((h, i) => (i === at ? next : h));
      });
    };
    const off = api.onJobProgress((p) => take(p, true));
    api.jobProgress().then((ps) => ps.forEach((p) => take(p, false)), () => undefined);
    return () => {
      live = false;
      off();
    };
  }, [api, ...deps]);
  return heard;
}

/** The progress of the one running job that `match` picks (§4.11), or undefined while none runs. */
export function useJob(match: (p: JobProgress) => boolean, deps: unknown[]): HeardJob | undefined {
  return useJobs(match, deps).at(-1);
}
