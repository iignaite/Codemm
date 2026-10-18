// What a screen shows when its work stopped (§5): background work that stalled, or data that couldn't load.
import { useEffect } from 'react';
import { SIGNED_OUT, type CourseView } from '../../shared/api';
import { Button } from '../ui/Button';
import { useApi } from './api';
import { SAY, problemOf, repairDetail } from './errors';
import { useRouter } from './router';
import { useBusy } from './useBusy';

/** Background work stopped after its retry, and nothing was recorded (§5). A sign-out goes to connect instead. */
export function Stalled({ stalled, retry }: { stalled: NonNullable<CourseView['stalled']>; retry: () => void }) {
  const api = useApi();
  const { route, go, fail } = useRouter();
  // Try again runs once: a double click starts the work once.
  const starting = useBusy();
  useEffect(() => {
    if (stalled === 'signed-out') fail(new Error(SIGNED_OUT));
  }, [stalled, fail]);
  if (stalled === 'signed-out') return null;

  const again = () =>
    starting.guard(async () => {
      try {
        await api.retryJobs();
        retry();
      } catch (e) {
        fail(e);
      }
    });

  return (
    <div className="failed" role="alert">
      {stalled === 'failed' ? "Codemm couldn't finish that." : SAY[stalled]}
      {stalled === 'failed' && <Button variant="text" onClick={() => go({ to: 'connect', then: route })}>Check your agent</Button>}
      {/* An agent Codemm couldn't stop is still running: only quitting stops it (§3.1). */}
      {stalled !== 'unstoppable' && <Button variant="text" disabled={starting.busy} onClick={again}>Try again</Button>}
    </div>
  );
}

/** A screen whose data couldn't load. An agent that is missing or signed out goes to connect instead. */
export function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  const { fail } = useRouter();
  const problem = problemOf(error);
  useEffect(() => {
    if (problem === 'connect') fail(error);
  }, [problem, error, fail]);
  if (problem === 'connect') return null;
  return (
    <main className="center">
      <div className="stack" role="alert">
        {/* Main lets only learner-safe messages through (errors.ts), so another failure shows its own. */}
        <p className="sub">{problem === 'other' ? (error instanceof Error && error.message) || SAY.other : SAY[problem]}</p>
        {problem === 'repair' && <p className="sub">{repairDetail(error)}</p>}
        <Button variant="ghost" onClick={retry}>Try again</Button>
      </div>
    </main>
  );
}
