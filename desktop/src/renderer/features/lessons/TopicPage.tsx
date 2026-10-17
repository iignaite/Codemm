import type { Course } from '../../../shared/api';
import { useApi, useLive } from '../../app/api';
import { activityOpen, useNav } from '../../app/nav';
import { Button } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon, StatusIcon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { paletteFor } from '../../ui/palette';

function SetupFailed({ course }: { course: Course }) {
  const api = useApi();
  const { go } = useNav();
  const retrying = course.setup === 'retrying';
  return (
    <div className="card a-pop" role="alert" style={{ width: 520, padding: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <Emm mood="think" width={150} palette={paletteFor(course.title)} />
      <h1 className="h2">Couldn't set up {course.track}</h1>
      {retrying && <>
        <p className="sub">Codemm is trying another way.</p>
        <div className="status"><StatusIcon status="run" size={18} label="" />Trying again</div>
      </>}
      <div className="row-actions" style={{ marginTop: 6 }}>
        <Button kind="ghost" size="lg" onClick={() => go({ to: 'goal' })}>Stop</Button>
        <Button size="lg" onClick={() => api.setUpTrack(course.id)}>Try now</Button>
      </div>
    </div>
  );
}

/** A topic's lessons and activity. Reading starts as soon as the first lesson exists. */
export function TopicPage({ topicId }: { topicId: string }) {
  const { go, courseId } = useNav();
  const course = useLive((api) => api.getCourse(courseId!), [courseId]);
  const topic = course?.topics.find((t) => t.id === topicId);
  if (!course || !topic) return <main className="center" />;
  if (course.setup === 'failed' || course.setup === 'retrying') return <main className="center"><SetupFailed course={course} /></main>;
  const open = activityOpen(topic);

  return (
    <main className="center">
      <div style={{ width: 620, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <h1 className="h1 a-up">{topic.title}</h1>
        <div className="card" style={{ padding: '4px 22px' }}>
          {topic.lessons.map((l, i) => (
            <div key={l.id} className="row a-up" style={stagger(i, 300)}>
              <Icon name="book" color={l.state === 'writing' ? '#5B6A84' : '#0E7C35'} size={18} />
              {l.state === 'writing'
                ? <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}><span>{l.title}</span><span className="shim" style={{ width: '60%' }} /></span>
                : <>
                  <span style={{ flex: 1 }}>{l.title}</span>
                  {l.state === 'read' && <span role="img" aria-label="Read"><Icon name="check" color="#0E7C35" size={14} /></span>}
                  <Button kind={l.state === 'read' ? 'ghost' : 'primary'} aria-label={`Read ${l.title}`} onClick={() => go({ to: 'lesson', lessonId: l.id })}>Read</Button>
                </>}
            </div>
          ))}
          <div className={`row a-up ${open ? '' : 'off'}`} style={stagger(topic.lessons.length, 300)}>
            <Icon name="code" color={open ? '#0E2754' : '#5B6A84'} size={18} />
            <span style={{ flex: 1 }}>Activity</span>
            {open
              ? <Button aria-label="Start the activity" onClick={() => go({ to: 'practice', exerciseId: topic.activity! })}>Start</Button>
              : <span role="img" aria-label="Locked"><Icon name="lock" color="#5B6A84" size={16} /></span>}
          </div>
        </div>
        {course.setup === 'running' && (
          <div className="status a-up" style={stagger(topic.lessons.length + 1, 300)}>
            <StatusIcon status="run" size={18} label="" />Setting up {course.track}
          </div>
        )}
      </div>
    </main>
  );
}
