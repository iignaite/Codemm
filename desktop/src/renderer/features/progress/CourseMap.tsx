import { useState } from 'react';
import type { CourseView, TopicView, Usage } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed, Stale, Stalled } from '../../app/Problems';
import { useCourse } from '../../app/useCourse';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { Goal } from '../learn/Goal';
import { Complete } from './Complete';
import { continueRoute, reviewText } from '../../app/course';

const STATE_LABEL = { mastered: 'Mastered', now: 'Now', later: 'Later' } as const;

/** Lessons, then an activity, per topic, with mastery so far. */
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
        <ol className="graph" aria-label="Topics">
          {course.topics.map((t, i) => <MapItem key={t.id} topic={t} index={i} course={course} />)}
        </ol>
      </div>
      <Aside course={course} usage={usage ?? null} />
      {course.stalled && <Stalled stalled={course.stalled} retry={reload} />}
      {stale !== undefined && <Stale error={stale} retry={reload} />}
    </main>
  );
}

function MapItem({ topic, index, course }: { topic: TopicView; index: number; course: CourseView }) {
  const { go } = useRouter();
  const prev = course.topics[index - 1];
  const icon = { mastered: <Icon name="check" color="#0E7C35" />, now: <Icon name="code" color="#0E7C35" />, later: <Icon name="lock" color="#8492A9" size={17} /> }[topic.state];
  return (
    <li className="gi">
      <div className="gr">
        {prev && <span className={`lt${prev.state === 'mastered' ? ' g' : ''}`} />}
        {index < course.topics.length - 1 && <span className={`lb${topic.state === 'mastered' ? ' g' : ''}`} />}
        <span className={topic.state === 'mastered' ? 'a-pop' : undefined} style={stagger(index, 100)} role="img" aria-label={STATE_LABEL[topic.state]}>{icon}</span>
      </div>
      {topic.review ? (
        <div className="card now-card a-up" style={stagger(0, 500)}>
          <b>{topic.title}</b>
          {topic.review === 'due' ? (
            <Button onClick={() => go({ to: 'practice', concept: topic.id })}>Review</Button>
          ) : (
            <span className="shim" style={{ width: 96 }} role="img" aria-label="Writing the review" />
          )}
        </div>
      ) : topic.state === 'now' ? (
        <div className="card now-card a-up" style={stagger(0, 500)}>
          <b>{topic.title}</b>
          {topic.lessons.every((l) => l.state === 'read') && <span className="done"><Icon name="check" color="#0E7C35" size={14} />Lessons</span>}
          <Button onClick={() => go(continueRoute(topic))}>Continue</Button>
        </div>
      ) : topic.state === 'mastered' ? (
        // A mastered topic opens again: its lessons and the activity, to reread or practise.
        <button type="button" className="grow mastered link" onClick={() => go({ to: 'topic', topicId: topic.id })}>{topic.title}</button>
      ) : (
        <div className={`grow ${topic.state}`}>{topic.title}</div>
      )}
    </li>
  );
}

function Aside({ course, usage }: { course: CourseView; usage: Usage | null }) {
  const started = course.topics.filter((t) => t.state !== 'later');
  return (
    <aside className="map-side">
      <section className="card a-up" style={stagger(1)} aria-labelledby="mastery-t">
        <h2 className="h3" id="mastery-t">Mastery</h2>
        {started.map((t, i) => (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</span>
            <div className="bar" role="img" aria-label={`${t.title}: ${t.state === 'mastered' ? 'mastered' : 'in progress'}`}>
              <i style={{ width: `${Math.round(t.mastery * 100)}%`, ...stagger(0, 500 + i * 100) }} />
            </div>
            {t.reviewIn && <span className="soon">{reviewText(t.reviewIn)}</span>}
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
