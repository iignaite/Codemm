import { useState } from 'react';
import type { CourseView, TopicView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { settled } from '../../app/course';
import { problemOf } from '../../app/errors';
import { useRouter } from '../../app/router';
import { Failed, Stalled } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon, Status } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { SetupConsent } from './SetupConsent';

const BUSY = { proposing: 'Preparing setup for', installing: 'Setting up' } as const;

/** A topic's lessons, then its activity. Reading starts as soon as the first lesson exists; setup runs beside it. */
export function TopicPage({ topicId }: { topicId: string }) {
  const api = useApi();
  const { fail } = useRouter();
  const { data: course, error, reload } = useLoad(() => api.course(), [topicId], settled);
  const [consentClosed, setConsentClosed] = useState(false);
  const [consentError, setConsentError] = useState<string>();
  if (error) return <Failed error={error} retry={reload} />;
  const topic = course?.topics.find((t) => t.id === topicId);
  if (!course || !topic) return null;
  if (course.setup === 'failed') return <SetupFailed course={course} topicId={topicId} onRetry={reload} />;

  async function install(digest: string) {
    try {
      await api.install(digest);
      setConsentError(undefined);
    } catch (e) {
      if (problemOf(e) === 'connect') return fail(e);
      // The proposal changed since the learner saw it: show the new one, and say why.
      setConsentError((e as Error).message);
    }
    reload();
  }

  const proposal = course.setup === 'consent' ? course.proposal : undefined;
  return (
    <main className="center">
      <div className="topic-page">
        <h1 className="h1 a-up">{topic.title}</h1>
        <Items topic={topic} />
        {(course.setup === 'proposing' || course.setup === 'installing') && (
          <div className="busy a-up" style={stagger(3, 300)}><Status kind="run" size={18} />{BUSY[course.setup]} {course.track}</div>
        )}
        {proposal && consentClosed && (
          <div className="a-up"><Button onClick={() => setConsentClosed(false)}>Set up {course.track}</Button></div>
        )}
      </div>
      {proposal && !consentClosed && (
        <SetupConsent track={course.track} proposal={proposal} error={consentError} onClose={() => setConsentClosed(true)} onSetUp={() => install(proposal.digest)} />
      )}
      {course.stalled && <Stalled stalled={course.stalled} retry={reload} />}
    </main>
  );
}

function Items({ topic }: { topic: TopicView }) {
  const { go } = useRouter();
  const open = topic.activity === 'open' || topic.activity === 'passed';
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
      <div className={`row a-up${open ? '' : ' off'}`} style={stagger(topic.lessons.length, 300)}>
        <Icon name="code" color="#5B6A84" size={18} />
        <span style={{ flex: 1 }}>Activity</span>
        {open ? (
          <Button onClick={() => go({ to: 'practice', concept: topic.id })}>{topic.activity === 'passed' ? 'Again' : 'Start'}</Button>
        ) : (
          <span role="img" aria-label="Opens after the lessons"><Icon name="lock" color="#5B6A84" size={16} /></span>
        )}
      </div>
    </div>
  );
}

/** Setup failed and nothing was recorded. Offline, low disk and Docker are this computer's problems: fix, then try the same setup again. */
function SetupFailed({ course, topicId, onRetry }: { course: CourseView; topicId: string; onRetry: () => void }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const problem = course.setupProblem ?? 'gates';
  const say = {
    offline: { title: "You're offline.", text: 'Connect to the internet, then try again.' },
    disk: { title: 'Not enough disk space.', text: 'Free some space on this computer, then try again.' },
    docker: { title: 'Docker stopped.', text: 'Start Docker, then try again.' },
    gates: { title: `Couldn't set up ${course.track}`, text: 'Try again, or stop and pick something else.' },
  }[problem];

  async function retry() {
    try {
      if (problem !== 'gates' && course.proposal) await api.install(course.proposal.digest);
      else await api.retrySetup();
      onRetry();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <main className="center">
      <div className="card panel a-pop" role="alert">
        <Emm mood="think" width={150} name={course.track} perch />
        <h1 className="h2">{say.title}</h1>
        <p className="sub">{say.text}</p>
        <div className="actions">
          {problem === 'gates' && <Button variant="ghost" size="lg" onClick={() => go({ to: 'goal' })}>Stop</Button>}
          {problem === 'docker' && <Button variant="ghost" size="lg" onClick={() => go({ to: 'computer', then: { to: 'topic', topicId } })}>Check this computer</Button>}
          <Button size="lg" onClick={retry}>Try again</Button>
        </div>
      </div>
    </main>
  );
}
