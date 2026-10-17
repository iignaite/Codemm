import { useEffect } from 'react';
import type { Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Emm } from '../../ui/Emm';
import { stagger } from '../../ui/motion';

/** Codemm's agent researches the goal and suggests a path, which the learner then edits. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(() => api.research(goal), [goal], (r) => r.done);

  useEffect(() => {
    if (data?.done) go({ to: 'course', draft: { title: data.title, track: data.track, installed: data.installed, topics: data.path.map((s) => s.title) } });
  }, [data, go]);

  if (error) return <Failed retry={reload} />;

  return (
    <main className="main page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Emm mood="think" width={110} />
        <h1 className="h1 a-up">Researching {goal.topic}</h1>
      </div>
      <div className="research" aria-live="polite">
        <section className="card" aria-labelledby="path">
          <h2 className="h3" id="path">Suggested path</h2>
          {data?.path.map((step, i) => (
            <div className="row a-up" key={step.title} style={stagger(0, 100)}>
              <span className="step" aria-hidden="true">{i + 1}</span>
              {step.title}
              {step.because && <span className="pill">{step.because}</span>}
            </div>
          ))}
          <div className="row"><span className="shim" style={{ width: '55%' }} /></div>
        </section>
      </div>
    </main>
  );
}
