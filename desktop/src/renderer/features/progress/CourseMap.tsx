import type { CourseView, TopicView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { settled } from '../../app/course';
import { useRouter, type Route } from '../../app/router';
import { Failed, Stalled } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { Goal } from '../learn/Goal';
import { Complete } from './Complete';

const STATE_LABEL = { mastered: 'Mastered', now: 'Now', later: 'Later' } as const;

function continueRoute(topic: TopicView): Route {
  return topic.activity === 'open' ? { to: 'practice', concept: topic.id } : { to: 'topic', topicId: topic.id };
}

/** Lessons, then an activity, per topic, with mastery so far. */
export function CourseMap() {
  const api = useApi();
  const { data: course, error, reload } = useLoad(() => api.course(), [], settled);
  if (error) return <Failed error={error} retry={reload} />;
  if (course === undefined) return null;
  if (course === null) return <Goal />;
  if (course.done) return <Complete course={course} />;
  return (
    <main className="main map">
      <div className="map-main">
        <h1 className="h2 a-up">{course.goal}</h1>
        <ol className="graph" aria-label="Topics">
          {course.topics.map((t, i) => <MapItem key={t.id} topic={t} index={i} course={course} />)}
        </ol>
      </div>
      <Aside course={course} />
      {course.stalled && <Stalled stalled={course.stalled} retry={reload} />}
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
      {topic.state === 'now' ? (
        <div className="card now-card a-up" style={stagger(0, 500)}>
          <b>{topic.title}</b>
          {topic.lessons.every((l) => l.state === 'read') && <span className="done"><Icon name="check" color="#0E7C35" size={14} />Lessons</span>}
          <Button onClick={() => go(continueRoute(topic))}>Continue</Button>
        </div>
      ) : (
        <div className={`grow ${topic.state}`}>{topic.title}</div>
      )}
    </li>
  );
}

function Aside({ course }: { course: CourseView }) {
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
          </div>
        ))}
      </section>
    </aside>
  );
}
