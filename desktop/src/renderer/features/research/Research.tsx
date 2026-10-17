import { useCallback, useEffect, useId, useState } from 'react';
import type { Goal, Research as Found } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon, StatusIcon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

const SOURCE_COLORS = ['#0B7A99', '#3F5DB8', '#6E4FC2', '#0E2754'];

function Pending({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, i) => (
    <div key={i} className="row"><span className="shim" style={{ width: `${70 - i * 12}%` }} /></div>
  ));
}

/** Codemm reads trusted sources, compares roadmaps, and suggests a path. */
export function Research({ goal }: { goal: Goal }) {
  const api = useApi();
  const { go } = useNav();
  const [found, setFound] = useState<Found>();
  const [failed, setFailed] = useState(false);
  const readingId = useId();
  const pathId = useId();

  const run = useCallback(() => {
    setFailed(false);
    api.research(goal).then(setFound, () => setFailed(true));
  }, [api, goal]);

  useEffect(run, [run]);

  return (
    <main className="main" style={{ padding: '56px 64px', gap: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <Emm mood="think" width={110} perch={false} />
        <h1 className="h1 a-up">Researching {goal.topic}</h1>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr)', gap: 28 }}>
        <section className="card" style={{ padding: '8px 22px' }} aria-labelledby={readingId}>
          <h2 className="h3" id={readingId} style={{ padding: '12px 0 4px' }}>Reading</h2>
          {found
            ? found.sources.map((name, i) => (
              <div key={name} className="row a-up" style={stagger(i, 300)}>
                <span className="badge" style={{ width: 28, height: 28, background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} aria-hidden="true">{name[0]}</span>
                <span style={{ flex: 1 }}>{name}</span>
                <Icon name="book" color="#5B6A84" size={16} />
              </div>
            ))
            : !failed && <><div className="row"><StatusIcon status="run" size={22} /><span className="shim" style={{ width: '50%' }} /></div><Pending rows={2} /></>}
        </section>
        <section className="card" style={{ padding: '8px 22px' }} aria-labelledby={pathId}>
          <h2 className="h3" id={pathId} style={{ padding: '12px 0 4px' }}>Suggested path</h2>
          {found
            ? found.draft.topics.map((t, i) => (
              <div key={t.id} className="row a-up" style={stagger(i, 900)}>
                <span className="step">{i + 1}</span>{t.title}
                {t.known && <span className="pill green" style={{ marginLeft: 'auto' }}>You know {t.known}</span>}
              </div>
            ))
            : !failed && <Pending rows={4} />}
        </section>
      </div>
      <div aria-live="polite">
        {found && <Button size="lg" onClick={() => go({ to: 'draft', draft: found.draft })}>Continue</Button>}
        {failed && (
          <div className="status">
            Research didn't finish.
            <Button kind="ghost" onClick={run}>Try again</Button>
          </div>
        )}
      </div>
    </main>
  );
}
