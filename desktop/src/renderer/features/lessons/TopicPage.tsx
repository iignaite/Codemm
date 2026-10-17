import type { Course, Topic } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon, Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

const settled = (c: Course | null) => !c || (c.setup !== 'running' && !c.topics.some((t) => t.state === 'now' && t.lessons.some((l) => l.state === 'writing')));

/** A topic's lessons, then its activity. Reading starts as soon as the first lesson exists. */
export function TopicPage({ topicId }: { topicId: string }) {
  const api = useApi();
  const { data: course, error, reload } = useLoad(() => api.course(), [topicId], settled);
  if (error) return <Failed retry={reload} />;
  const topic = course?.topics.find((t) => t.id === topicId);
  if (!course || !topic) return null;
  if (course.setup === 'failed') return <SetupFailed course={course} onRetry={reload} />;
  return (
    <main className="center">
      <div className="topic-page">
        <h1 className="h1 a-up">{topic.title}</h1>
        <Items topic={topic} />
        {course.setup === 'running' && (
          <div className="busy a-up" style={stagger(3, 300)}><Status kind="run" size={18} />Setting up {course.track}</div>
        )}
      </div>
    </main>
  );
}

function Items({ topic }: { topic: Topic }) {
  const { go } = useRouter();
  const { activity } = topic;
  return (
    <div className="card">
      {topic.lessons.map((l, i) => (
        <div className="row a-up" key={l.id} style={stagger(i, 300)}>
          <Icon name="book" color={l.state === 'writing' ? '#5B6A84' : '#0E7C35'} size={18} />
          {l.state === 'writing' ? (
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>{l.title}</span>
              <span className="shim" style={{ width: '60%' }} role="img" aria-label="Writing" />
            </span>
          ) : (
            <>
              <span style={{ flex: 1 }}>{l.title}</span>
              {l.state === 'read' && <Icon name="check" color="#0E7C35" size={14} />}
              <Button variant={l.state === 'read' ? 'ghost' : 'primary'} onClick={() => go({ to: 'lesson', lessonId: l.id })} aria-label={`Read ${l.title}`}>Read</Button>
            </>
          )}
        </div>
      ))}
      <div className={`row a-up${activity.state === 'open' || activity.state === 'passed' ? '' : ' off'}`} style={stagger(topic.lessons.length, 300)}>
        <Icon name="code" color="#5B6A84" size={18} />
        <span style={{ flex: 1 }}>{activity.title}</span>
        {activity.state === 'open' || activity.state === 'passed' ? (
          <Button onClick={() => go({ to: 'practice', activityId: activity.id })}>{activity.state === 'passed' ? 'Again' : 'Start'}</Button>
        ) : (
          <span role="img" aria-label="Opens after the lessons"><Icon name="lock" color="#5B6A84" size={16} /></span>
        )}
      </div>
    </div>
  );
}

/** Setup failed: nothing is lost; try again or go back and change the course. */
function SetupFailed({ course, onRetry }: { course: Course; onRetry: () => void }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const draft = { title: course.title, track: course.track, installed: false, topics: course.topics.map((t) => t.title) };
  async function retry() {
    try {
      await api.setUp();
      onRetry();
    } catch (e) {
      fail(e);
    }
  }
  return (
    <main className="center">
      <div className="card panel a-pop" role="alert">
        <Emm mood="think" width={150} name={course.track} perch />
        <h1 className="h2">Couldn't set up {course.track}</h1>
        <p className="sub">Try again, or change the course.</p>
        <div className="actions">
          <Button variant="ghost" size="lg" onClick={() => go({ to: 'course', draft })}>Stop</Button>
          <Button size="lg" onClick={retry}>Try now</Button>
        </div>
      </div>
    </main>
  );
}
