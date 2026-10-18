import { useEffect } from 'react';
import type { Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Problems';
import { useJob } from '../../app/useJob';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { EmmFill } from '../../ui/EmmFill';
import { fillOf, JobBar, sayStep } from '../../ui/JobBar';

/** Codemm's agent researches the goal and writes a roadmap, which the learner then edits. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(() => api.research(goal), [goal], (r) => r.state !== 'running');
  // What the agent is looking at, the latest first (§4.9, §4.11).
  const job = useJob((p) => p.kind === 'research', []);
  const steps = job?.progress.steps ?? [];
  const count = job?.progress.count ?? 0;

  useEffect(() => {
    if (data?.state === 'done' && data.roadmap) go({ to: 'course', roadmap: data.roadmap });
  }, [data, go]);

  if (error) return <Failed error={error} retry={reload} />;
  if (data?.state === 'failed') {
    return (
      <main className="center">
        <div className="card panel a-pop" role="alert">
          <Emm mood="soft" width={130} />
          <h1 className="h2">Codemm couldn't finish that.</h1>
          <div className="actions">
            <Button variant="ghost" size="lg" onClick={() => go({ to: 'connect', then: { to: 'research', goal } })}>Check your agent</Button>
            <Button size="lg" onClick={reload}>Try again</Button>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="main page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* While research runs, the heading's Emm is its progress, filling as it goes (§4.11). */}
        {job ? <EmmFill value={fillOf(job.progress)} width={110} dim={Boolean(job.progress.retry)} /> : <Emm mood="think" width={110} />}
        <h1 className="h1 a-up">Researching {goal.topic}</h1>
      </div>
      {job && (
        <section className="looking" aria-label="Research progress">
          <JobBar job={job} label={`Researching ${goal.topic}`} noLine emm={false} />
          {steps.length > 0 && (
            <ol aria-label="What Codemm is looking at">
              {steps.map((step, i) => (
                <li key={count - i} style={{ opacity: Math.max(0.35, 1 - i * 0.12) }}>{sayStep(step)}</li>
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
