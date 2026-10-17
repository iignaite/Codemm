import { useEffect } from 'react';
import type { Goal } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Emm, hueColor } from '../../ui/Emm';
import { Icon, Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** Codemm reads trusted sources, compares roadmaps and suggests a path. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useRouter();
  const { data, error, reload } = useLoad(() => api.research(goal), [goal], (r) => r.done);

  useEffect(() => {
    if (data?.done) go({ to: 'course', draft: { title: data.title, track: data.track, installed: data.installed, runsPerTopic: data.runsPerTopic, topics: data.path.map((s) => s.title) } });
  }, [data, go]);

  if (error) return <Failed retry={reload} />;
  const reading = data?.sources.findIndex((s) => !s.read) ?? 0;
  const sources = data?.sources.slice(0, reading < 0 ? undefined : reading + 1) ?? [];

  return (
    <main className="main page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Emm mood="think" width={110} />
        <h1 className="h1 a-up">Researching {goal.topic}</h1>
      </div>
      <div className="research" aria-live="polite">
        <section className="card" aria-labelledby="reading">
          <h2 className="h3" id="reading">Reading</h2>
          {sources.map((s, i) => (
            <div className="row a-up" key={s.name} style={stagger(0, 100)}>
              <span className="badge" style={{ width: 28, height: 28, background: hueColor(s.name) }} aria-hidden="true">{s.name[0]}</span>
              <span style={{ flex: 1 }}>{s.name}</span>
              {i === reading ? <Status kind="run" size={22} /> : <Icon name="book" color="#5B6A84" size={16} />}
            </div>
          ))}
        </section>
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
