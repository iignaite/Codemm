import { useState } from 'react';
import type { CourseView, Usage } from '../../../shared/api';
import { useApi } from '../../app/api';
import { Failed, Stale, Stalled } from '../../app/Problems';
import { useCourse } from '../../app/useCourse';
import { useLoad } from '../../app/useLoad';
import { stagger } from '../../ui/motion';
import { Goal } from '../learn/Goal';
import { Complete } from './Complete';
import { Path } from './Path';
import { SetupProgress } from './SetupProgress';

/** The course as a path the learner moves along, with mastery so far and what the agent used beside it. */
export function CourseMap() {
  const api = useApi();
  const { data: course, error, stale, reload } = useCourse();
  // Read again whenever the course is: jobs that finish while the map is open add to it.
  const { data: usage } = useLoad(() => api.usage(), [course]);
  // A finished course celebrates first; View course opens its map again.
  const [viewing, setViewing] = useState(false);
  if (error) return <Failed error={error} retry={reload} />;
  if (course === undefined) return null;
  if (course === null) return <Goal />;
  if (course.done && !viewing) return <Complete course={course} onView={() => setViewing(true)} />;
  return (
    <main className="main map">
      <div className="map-main">
        <div className="map-head a-up">
          <h1 className="h2">{course.title}</h1>
          {course.goal !== course.title && <p className="sub">{course.goal}</p>}
        </div>
        <SetupProgress course={course} />
        <Path course={course} />
      </div>
      <Aside course={course} usage={usage ?? null} />
      {course.stalled && <Stalled stalled={course.stalled} work={course.stalledWork} retry={reload} />}
      {stale !== undefined && <Stale error={stale} retry={reload} />}
    </main>
  );
}

function Aside({ course, usage }: { course: CourseView; usage: Usage | null }) {
  const started = course.topics.filter((t) => t.state !== 'later');
  const mastered = course.topics.filter((t) => t.state === 'mastered').length;
  return (
    <aside className="map-side">
      <section className="card a-up" style={stagger(1)} aria-labelledby="mastery-t">
        <h2 className="h3" id="mastery-t">Mastery</h2>
        <p className="tally"><b>{mastered}</b> of {course.topics.length} {course.topics.length === 1 ? 'topic' : 'topics'}</p>
        {started.map((t, i) => (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</span>
            <div className="bar" role="img" aria-label={`${t.title}: ${t.state === 'mastered' ? 'mastered' : 'in progress'}`}>
              <i style={{ width: `${Math.round(t.mastery * 100)}%`, ...stagger(0, 500 + i * 100) }} />
            </div>
          </div>
        ))}
      </section>
      {usage && usage.total.costUsd > 0 && <UsageCard cost={usage.total.costUsd} />}
    </aside>
  );
}

const dollars = (n: number) => (n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`);

/**
 * What the agent estimated the course has cost so far, once it reported a cost (§4.12). Only the estimate: token
 * counts are the agent's bookkeeping, agent names stay on the connect screen, and Codemm can't tell a plan from an
 * API key, so it says nothing about billing.
 */
function UsageCard({ cost }: { cost: number }) {
  return (
    <section className="card usage a-up" style={stagger(2)} aria-labelledby="usage-t">
      <h2 className="h3" id="usage-t">Usage</h2>
      <dl>
        <dt>Estimated cost</dt>
        <dd>{dollars(cost)}</dd>
      </dl>
    </section>
  );
}
