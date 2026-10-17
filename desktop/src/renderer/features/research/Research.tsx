import { useEffect } from 'react';
import type { Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';

/** Codemm's agent researches the goal and writes a roadmap, which the learner then edits. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(() => api.research(goal), [goal], (r) => r.state !== 'running');

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
        <Emm mood="think" width={110} />
        <h1 className="h1 a-up">Researching {goal.topic}</h1>
      </div>
      <section className="card research" aria-labelledby="path" aria-busy="true">
        <h2 className="h3" id="path">Suggested path</h2>
        <div className="row"><span className="shim" style={{ width: '70%' }} role="img" aria-label="Writing" /></div>
        <div className="row"><span className="shim" style={{ width: '55%' }} /></div>
        <div className="row"><span className="shim" style={{ width: '62%' }} /></div>
      </section>
    </main>
  );
}
