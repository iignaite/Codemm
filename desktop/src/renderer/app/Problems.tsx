// What a screen shows when its work stopped (§5): background work that stalled, or data that couldn't load.
import { useEffect } from 'react';
import { REBUILD, SIGNED_OUT, type CourseView } from '../../shared/api';
import { Button } from '../ui/Button';
import { useApi } from './api';
import { SAY, problemOf, repairDetail } from './errors';
import { useRouter } from './router';
import { useBusy } from './useBusy';

/** What a stall says when it isn't the agent's doing: this computer's problems, a rebuild, or a lesson that wasn't written. */
const STALL = {
  docker: 'Docker stopped. Start Docker, then try again.',
  'docker-busy': 'Docker is busy or not answering. Wait a moment, then try again.',
  'docker-failed': "Docker couldn't run that. Try again, and restart Docker if it happens again.",
  'docker-disk': 'Docker ran out of disk space. Remove unused images in Docker Desktop, then try again.',
  disk: 'Not enough disk space. Free some space on this computer, then try again.',
  wasi: "Codemm couldn't start the part that runs your code. Reinstall Codemm, then try again.",
  rebuild: REBUILD,
  lesson: "Codemm couldn't write this lesson.",
};
const named = (stalled: string): stalled is keyof typeof STALL => stalled in STALL;
/** The work that stopped, by its kind, so the banner never says "that" with nothing on screen to point at. */
const WORK = { setup: 'setting up the course', lesson: 'writing a lesson', author: 'writing an activity' };
const unfinished = (work: CourseView['stalledWork']) => `Codemm couldn't finish ${work ? WORK[work] : "the course's next step"}.`;

/** Background work stopped after its retry, and nothing was recorded (§5). A sign-out goes to connect instead. */
export function Stalled({ stalled, work, later, retry }: { stalled: NonNullable<CourseView['stalled']>; work?: CourseView['stalledWork']; later?: string; retry: () => void }) {
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
  // Leaves the topic whose activity couldn't be written for later: the topics after it open, unmastered (core §7).
  const leave = (concept: string) =>
    starting.guard(async () => {
      try {
        await api.skip(concept);
        retry();
      } catch (e) {
        fail(e);
      }
    });

  return (
    <div className="failed" role="alert">
      {stalled === 'failed' ? unfinished(work) : named(stalled) ? STALL[stalled] : SAY[stalled]}
      {stalled === 'failed' && <Button variant="text" onClick={() => go({ to: 'connect', then: route })}>Check your agent</Button>}
      {(stalled === 'docker' || stalled === 'docker-failed') && <Button variant="text" onClick={() => go({ to: 'computer', then: route })}>Check this computer</Button>}
      {stalled === 'rebuild' && <Button variant="text" onClick={() => go({ to: 'tracks' })}>Go to Tracks</Button>}
      {/* An agent Codemm couldn't stop is still running: only quitting stops it (§3.1). */}
      {stalled !== 'unstoppable' && <Button variant="text" disabled={starting.busy} onClick={again}>Try again</Button>}
      {later && <Button variant="text" disabled={starting.busy} onClick={() => leave(later)}>Come back later</Button>}
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

/**
 * A read failed after one worked: the screen keeps what it showed and says it couldn't refresh, with Try again. A
 * status, not an alert: nothing was lost. An agent that is missing or signed out goes to connect instead.
 */
export function Stale({ error, retry }: { error: unknown; retry: () => void }) {
  const { fail } = useRouter();
  const problem = problemOf(error);
  useEffect(() => {
    if (problem === 'connect') fail(error);
  }, [problem, error, fail]);
  if (problem === 'connect') return null;
  const why = problem === 'other' || problem === 'agent' ? '' : ` ${SAY[problem]}`;
  return (
    <div className="failed" role="status">
      Codemm couldn't refresh this.{why}
      <Button variant="text" onClick={retry}>Try again</Button>
    </div>
  );
}
