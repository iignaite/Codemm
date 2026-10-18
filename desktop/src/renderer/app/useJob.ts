import { useEffect, useState } from 'react';
import type { JobProgress } from '../../shared/api';
import { useApi } from './api';

/** A job's latest progress, and when it arrived here. */
export interface HeardJob {
  progress: JobProgress;
  at: number;
}

/**
 * The progress of the running job that `match` picks (§4.11), or undefined while none runs. A screen that opens
 * while the job runs gets its progress so far, then follows it; an ended job is dropped.
 */
export function useJob(match: (p: JobProgress) => boolean, deps: unknown[]): HeardJob | undefined {
  const api = useApi();
  const [heard, setHeard] = useState<HeardJob>();
  useEffect(() => {
    let live = true;
    setHeard(undefined);
    /** Jobs an event told about: what jobProgress read is older, and can't bring back one that ended. */
    const told = new Set<string>();
    const take = (p: JobProgress, fresh: boolean) => {
      if (!live || !match(p)) return;
      if (fresh) told.add(p.job);
      else if (told.has(p.job)) return;
      setHeard((h) => {
        if (p.ended) return h?.progress.job === p.job ? undefined : h;
        if (!fresh && h) return h;
        return { progress: p, at: Date.now() };
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
