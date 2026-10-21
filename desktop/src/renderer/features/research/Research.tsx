import { useEffect } from 'react';
import type { Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { SAY, problemOf, repairDetail } from '../../app/errors';
import { useJob } from '../../app/useJob';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { EmmFill } from '../../ui/EmmFill';
import { fillOf, JobBar, sayStep } from '../../ui/JobBar';
import { Panel } from '../../ui/Panel';
import { shownTopic } from '../../../shared/topic';

/** Codemm's agent researches the goal and writes a roadmap, which the learner then edits. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, stale, reload } = useLoad(() => api.research(goal), [goal], { settled: (r) => r.state !== 'running' });
  // What the agent is looking at, the latest first (§4.9, §4.11).
  const job = useJob((p) => p.kind === 'research', []);
  const topic = shownTopic(goal.topic);
  const steps = job?.progress.steps ?? [];
  const count = job?.progress.count ?? 0;

  useEffect(() => {
    if (data?.state === 'done' && data.roadmap) go({ to: 'course', roadmap: data.roadmap });
  }, [data, go]);

  // A read that fails, first or later, is research that couldn't finish: there's no roadmap yet to keep on screen.
  const problem = error ?? stale;
  if (problem !== undefined || data?.state === 'failed') return <NotFinished goal={goal} error={problem} retry={reload} />;
  return (
    <main className="main page">
      <div className="page-head">
        {/* While research runs, the heading's Emm is its progress, filling as it goes (§4.11). */}
        {job ? <EmmFill value={fillOf(job.progress)} width={110} dim={Boolean(job.progress.retry)} /> : <Emm mood="think" width={110} />}
        <h1 className="h1 a-up">Researching {topic}</h1>
      </div>
      {job && (
        <section className="looking" aria-label="Research progress">
          <JobBar job={job} label={`Researching ${topic}`} noLine emm={false} />
          {steps.length > 0 && (
            <ol aria-label="What Codemm is looking at">
              {steps.map((step, i) => (
                // The latest step stands out by its color; older ones stay readable (WCAG AA), never faded.
                <li key={count - i} className={i === 0 ? 'now' : undefined}>{sayStep(step)}</li>
              ))}
            </ol>
          )}
          {count > 0 && <span className="soon">{count === 1 ? '1 step' : `${count} steps`}</span>}
        </section>
      )}
      <section className="card research" aria-labelledby="path" aria-busy="true">
        <h2 className="h3" id="path">Suggested path</h2>
        <div className="row"><span className="shim" style={{ width: '70%' }} role="img" aria-label="Writing" /></div>
        <div className="row"><span className="shim" style={{ width: '55%' }} /></div>
        <div className="row"><span className="shim" style={{ width: '62%' }} /></div>
      </section>
    </main>
  );
}

/** Research stopped, or Codemm couldn't read how it's going: why, when Codemm knows, with Try again and Check your agent. */
function NotFinished({ goal, error, retry }: { goal: Goal; error?: unknown; retry: () => void }) {
  const { go, fail } = useRouter();
  const problem = error === undefined ? undefined : problemOf(error);
  // A missing or signed-out agent goes to connect, as everywhere else.
  useEffect(() => {
    if (problem === 'connect') fail(error);
  }, [problem, error, fail]);
  if (problem === 'connect') return null;
  // Main lets only learner-safe messages through (errors.ts). An agent's failure is already the title.
  const why =
    problem === undefined || problem === 'agent'
      ? undefined
      : problem === 'other'
        ? (error instanceof Error && error.message) || SAY.other
        : problem === 'repair'
          ? `${SAY.repair} ${repairDetail(error)}`
          : SAY[problem];
  return (
    <main className="center">
      <Panel art={<Emm mood="soft" width={130} />} title="Codemm couldn't finish that." text={why}>
        {/* Offline isn't the agent's doing. */}
        {problem !== 'offline' && <Button variant="ghost" size="lg" onClick={() => go({ to: 'connect', then: { to: 'research', goal } })}>Check your agent</Button>}
        <Button size="lg" onClick={retry}>Try again</Button>
      </Panel>
    </main>
  );
}
