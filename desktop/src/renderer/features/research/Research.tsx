import { useEffect } from 'react';
import { AGENT_FAILED, type Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Emm } from '../../ui/Emm';

/** Codemm's agent researches the goal and writes a roadmap, which the learner then edits. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const { data, error, reload } = useLoad(() => api.research(goal), [goal], (r) => r.state !== 'running');

  useEffect(() => {
    if (data?.state === 'done' && data.roadmap) go({ to: 'course', roadmap: data.roadmap });
    if (data?.state === 'failed') fail(new Error(AGENT_FAILED), { to: 'goal' });
  }, [data, go, fail]);

  if (error) return <Failed error={error} retry={reload} />;
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
