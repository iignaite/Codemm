import type { CourseView, TopicView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed, Stale, Stalled } from '../../app/Problems';
import { useBusy } from '../../app/useBusy';
import { useJob } from '../../app/useJob';
import { useCourse } from '../../app/useCourse';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { JobBar } from '../../ui/JobBar';
import { stagger } from '../../ui/motion';
import { SetupOffer } from './SetupConsent';
import { Writing } from './Writing';
import { Panel } from '../../ui/Panel';
import { Busy } from '../../ui/Busy';

const BUSY = { proposing: 'Preparing setup for', installing: 'Setting up' } as const;

/** A topic's lessons, then its activity. Reading starts as soon as the first lesson exists; setup runs beside it. */
export function TopicPage({ topicId }: { topicId: string }) {
  const { data: course, error, stale, reload } = useCourse([topicId]);
  // Setup's progress: the agent proposing, then Codemm building and checking (§4.11). A proposing agent may still be
  // ending its turn while the install runs, so each state follows its own job.
  const installing = course?.setup === 'installing';
  const setupJob = useJob((p) => p.kind === 'setup' && (installing ? p.stage > 0 : p.stage === 0), [installing]);
  if (error) return <Failed error={error} retry={reload} />;
  const topic = course?.topics.find((t) => t.id === topicId);
  if (!course || !topic) return null;

  return (
    <main className="center">
      <div className="topic-page">
        <h1 className="h1 a-up">{topic.title}</h1>
        {/* A failed setup says so above the lessons, which stay readable. */}
        {course.setup === 'failed' && <SetupFailed course={course} topicId={topicId} onRetry={reload} />}
        <Items topic={topic} onRetry={reload} />
        {(course.setup === 'proposing' || course.setup === 'installing') &&
          (setupJob ? (
            <section className="card setup-progress a-up" style={stagger(3, 300)} aria-labelledby="setup-progress-t">
              <h2 className="h3" id="setup-progress-t">Setting up {course.track}</h2>
              <JobBar job={setupJob} label={`Setting up ${course.track}`} />
            </section>
          ) : (
            <Busy className="a-up" style={stagger(3, 300)}>{BUSY[course.setup]} {course.track}</Busy>
          ))}
        <SetupOffer course={course} onChange={reload} />
      </div>
      {/* A lesson that wasn't written says so on its own row. */}
      {course.stalled && !(course.stalled === 'lesson' && topic?.lessons.some((l) => l.state === 'failed')) && <Stalled stalled={course.stalled} work={course.stalledWork} retry={reload} />}
      {stale !== undefined && <Stale error={stale} retry={reload} />}
    </main>
  );
}

function Items({ topic, onRetry }: { topic: TopicView; onRetry: () => void }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const open = topic.activity === 'open' || topic.activity === 'passed';
  // Try again runs once: a double click starts the lesson once.
  const retrying = useBusy();
  const retry = () =>
    retrying.guard(async () => {
      try {
        await api.retryJobs();
        onRetry();
      } catch (e) {
        fail(e);
      }
    });
  return (
    <div className="card">
      {topic.lessons.map((l, i) => (
        <div className={`row a-up${l.state === 'writing' ? ' writing' : ''}`} key={l.id} style={stagger(i, 300)}>
          <Icon name="book" color={l.state === 'writing' ? 'var(--faint)' : 'var(--green-ink)'} size={18} />
          {l.state === 'writing' ? (
            <>
              <span className="fill">{l.title}</span>
              <Writing kind="lesson" concept={topic.id} label="Writing the lesson" />
            </>
          ) : l.state === 'failed' ? (
            <>
              <span className="fill">Codemm couldn't write this lesson.</span>
              <Button variant="ghost" disabled={retrying.busy} onClick={retry}>Try again</Button>
            </>
          ) : (
            <>
              <span className="fill">{l.title}</span>
              {l.state === 'read' && <Icon name="check" color="var(--green-ink)" size={14} />}
              <Button variant={l.state === 'read' ? 'ghost' : 'primary'} onClick={() => go({ to: 'lesson', lessonId: l.id })} aria-label={`Read ${l.title}`}>Read</Button>
            </>
          )}
        </div>
      ))}
      <div className={`row a-up${open ? '' : ' off'}${topic.activity === 'writing' ? ' writing' : ''}`} style={stagger(topic.lessons.length, 300)}>
        <Icon name="code" color="var(--faint)" size={18} />
        <span className="fill">{topic.review ? 'Review' : 'Activity'}</span>
        {open ? (
          <Button onClick={() => go({ to: 'practice', concept: topic.id })}>{topic.activity === 'passed' ? 'Again' : 'Start'}</Button>
        ) : topic.activity === 'writing' ? (
          <Writing
            kind="author" concept={topic.id} label={topic.review ? 'Writing the review' : 'Writing the activity'}
            waiting={topic.lessons.some((l) => l.state === 'writing') ? 'Waiting for the lesson' : undefined}
          />
        ) : (
          <span className="locked"><Icon name="lock" color="var(--faint)" size={16} />Opens after you finish the lessons</span>
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
    'docker-busy': { title: 'Docker is busy or not answering.', text: 'Wait a moment, then try again.' },
    'docker-failed': { title: "Docker couldn't run that.", text: 'Try again, and restart Docker if it happens again.' },
    'docker-disk': { title: 'Docker ran out of disk space.', text: 'Remove unused images in Docker Desktop, then try again.' },
    gates: { title: `Couldn't set up ${course.track}.`, text: 'Try again, or stop and pick something else.' },
  }[problem];

  // Try again runs once: a double click starts one retry.
  const retrying = useBusy();
  const retry = () =>
    retrying.guard(async () => {
      try {
        if (problem !== 'gates' && course.proposal) await api.install(course.proposal.digest);
        else await api.retrySetup();
        onRetry();
      } catch (e) {
        fail(e);
      }
    });

  return (
    <Panel art={<Emm mood="think" width={150} name={course.track} perch />} title={say.title} level={2} text={say.text}>
      {(problem === 'gates' || problem.startsWith('docker')) && <Button variant="ghost" size="lg" onClick={() => go({ to: 'goal' })}>Stop</Button>}
      {(problem === 'docker' || problem === 'docker-failed') && <Button variant="ghost" size="lg" onClick={() => go({ to: 'computer', then: { to: 'topic', topicId } })}>Check this computer</Button>}
      <Button size="lg" disabled={retrying.busy} onClick={retry}>Try again</Button>
    </Panel>
  );
}
