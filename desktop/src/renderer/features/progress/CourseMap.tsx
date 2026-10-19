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
        <h1 className="h2 a-up">{course.goal}</h1>
        <SetupProgress course={course} />
        <Path course={course} />
      </div>
      <Aside course={course} usage={usage ?? null} />
      {course.stalled && <Stalled stalled={course.stalled} retry={reload} />}
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
        <p className="tally"><b>{mastered}</b> of {course.topics.length} topics</p>
        {started.map((t, i) => (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</span>
            <div className="bar" role="img" aria-label={`${t.title}: ${t.state === 'mastered' ? 'mastered' : 'in progress'}`}>
              <i style={{ width: `${Math.round(t.mastery * 100)}%`, ...stagger(0, 500 + i * 100) }} />
            </div>
          </div>
        ))}
      </section>
      {usage && usage.total.runs > 0 && <UsageCard usage={usage} />}
    </aside>
  );
}

const tokens = (n: number) => n.toLocaleString('en-US');
const dollars = (n: number) => (n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`);

/** What the agent reported using for this course: tokens, and Claude's own cost estimate when it gave one (§4.12). */
function UsageCard({ usage }: { usage: Usage }) {
  const { total } = usage;
  return (
    <section className="card usage a-up" style={stagger(2)} aria-labelledby="usage-t">
      <h2 className="h3" id="usage-t">Usage</h2>
      <dl>
        <dt>Tokens in</dt>
        <dd>{tokens(total.input)}</dd>
        <dt>Tokens out</dt>
        <dd>{tokens(total.output)}</dd>
        {total.costUsd > 0 && (
          <>
            <dt>Claude's estimate</dt>
            <dd>{dollars(total.costUsd)}</dd>
          </>
        )}
      </dl>
      {/* The row says it's Claude's estimate, and nothing more: Codemm can't tell a plan from an API key. */}
    </section>
  );
}
