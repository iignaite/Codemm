import type { Course, Topic } from '../../../shared/api';
import { useLive } from '../../app/api';
import { continueRoute, useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { paletteFor, type PaletteName } from '../../ui/palette';
import { Complete } from './Complete';

const STATE_ICON = {
  mastered: { label: 'Mastered', icon: <Icon name="check" color="#0E7C35" size={20} /> },
  now: { label: 'Now', icon: <Icon name="code" color="#0E7C35" size={20} /> },
  later: { label: 'Later', icon: <Icon name="lock" color="#8492A9" size={17} /> },
};

function Step({ topic, prev, last, i }: { topic: Topic; prev?: Topic; last: boolean; i: number }) {
  const { go } = useNav();
  const { label, icon } = STATE_ICON[topic.state];
  return (
    <li className="gi">
      <div className="gr">
        {prev && <span className={`lt ${prev.state === 'mastered' ? 'g' : ''}`} />}
        {!last && <span className={`lb ${topic.state === 'mastered' ? 'g' : ''}`} />}
        <span role="img" aria-label={label} className={topic.state === 'mastered' ? 'a-pop' : ''} style={stagger(i, 100)}>{icon}</span>
      </div>
      {topic.state === 'now'
        ? (
          <div className="card head a-up" style={stagger(0, 500)}>
            <b>{topic.title}</b>
            {topic.lessons.length > 0 && topic.lessons.every((l) => l.state === 'read') && (
              <span className="status" style={{ color: 'var(--green-ink)', fontWeight: 600 }}><Icon name="check" color="#0E7C35" size={14} />Lessons</span>
            )}
            <Button onClick={() => go(continueRoute(topic))}>Continue</Button>
          </div>
        )
        : <div className={`grow ${topic.state === 'later' ? 'later' : ''}`}>{topic.title}</div>}
    </li>
  );
}

function Review({ topic, palette }: { topic: Topic; palette: PaletteName }) {
  const { go } = useNav();
  return (
    <section className="card notice a-up" style={{ ...stagger(1), flexDirection: 'column', alignItems: 'stretch', padding: 20 }} aria-label="Review">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Emm mood="look" width={70} perch={false} palette={palette} />
        <div><b style={{ fontSize: 16, color: 'var(--ink)' }}>Review {topic.title}</b><div style={{ fontSize: 14 }}>A quick one keeps it fresh.</div></div>
      </div>
      <Button onClick={() => go({ to: 'practice', exerciseId: topic.activity! })}><Icon name="review" color="#fff" size={18} />Review</Button>
    </section>
  );
}

function Mastery({ course }: { course: Course }) {
  const shown = course.topics.filter((t) => t.state !== 'later');
  return (
    <section className="card a-up" style={{ ...stagger(2), padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Mastery">
      <h2 className="h3">Mastery</h2>
      {shown.map((t, i) => {
        const mastered = t.state === 'mastered';
        return (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</span>
            <div className="bar" role="img" aria-label={`${t.title}: ${mastered ? 'mastered' : 'in progress'}`}>
              <i style={{ width: `${mastered ? 100 : Math.round(t.mastery * 100)}%`, ...stagger(0, 500 + i * 100) }} />
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Lessons, then an activity, per topic. Mastered topics come back for review. */
export function CourseMap() {
  const { courseId } = useNav();
  const course = useLive((api) => api.getCourse(courseId!), [courseId]);
  if (!course) return <main className="main" />;
  if (course.topics.every((t) => t.state === 'mastered')) return <Complete course={course} />;
  const palette = paletteFor(course.title);
  const review = course.topics.find((t) => t.id === course.review && t.activity);

  return (
    <main className="main" style={{ flexDirection: 'row' }}>
      <div style={{ flex: 1, minWidth: 0, padding: '36px 48px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 className="h2 a-up">{course.title}</h1>
        <ol className="graph">
          {course.topics.map((t, i) => <Step key={t.id} topic={t} prev={course.topics[i - 1]} last={i === course.topics.length - 1} i={i} />)}
        </ol>
      </div>
      <aside className="aside">
        {review && <Review topic={review} palette={palette} />}
        <Mastery course={course} />
      </aside>
    </main>
  );
}
