import { useCallback, useEffect, useRef, useState } from 'react';
import type { Activity, CourseView, TopicView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { continueRoute, offeredTopic, settled } from '../../app/course';
import { useConversation } from '../../app/useConversation';
import { useRouter } from '../../app/router';
import { Failed, Stale, Stalled } from '../../app/Problems';
import { Sidebar } from '../../app/Sidebar';
import { useLoad } from '../../app/useLoad';
import { useRun } from '../../app/useRun';
import { Button } from '../../ui/Button';
import { Markdown } from '../../ui/Markdown';
import { stagger } from '../../ui/motion';
import { Rail } from '../../ui/Rail';
import { Terminal, type TerminalHandle } from '../../ui/Terminal';
import { Editor } from './Editor';
import { Results } from './Results';
import { useAttempt } from './useAttempt';
import { useLearnerFiles } from './useLearnerFiles';
import { RunButton } from '../../ui/RunButton';
import { Writing } from '../lessons/Writing';

export function Practice({ concept }: { concept: string }) {
  const api = useApi();
  // The activity opens once its lessons are read and it's written (§4.3); until then this screen says so.
  const { data, error, stale, reload } = useLoad(
    async () => {
      const course = (await api.course())!;
      const topic = course.topics.find((t) => t.id === concept);
      const waiting = topic?.activity === 'locked' || topic?.activity === 'writing';
      return { course, topic, activity: waiting ? undefined : await api.activity(concept) };
    },
    [concept],
    // While it's written, read again until it opens or the course's work stops (a stall, or setup waiting on the learner).
    { settled: (d) => d.topic?.activity !== 'writing' || settled(d.course) },
  );
  // An activity that opens after the learner waited here takes focus, as a new screen's heading does.
  const waited = useRef(false);
  if (error) return <><Sidebar slim /><Failed error={error} retry={reload} /></>;
  if (!data) return <Sidebar slim />;
  if (!data.activity) {
    waited.current = true;
    return <><Sidebar slim /><Waiting topic={data.topic!} course={data.course} stale={stale} retry={reload} /></>;
  }
  return <><Sidebar slim /><Workspace activity={data.activity} course={data.course} focus={waited.current} /></>;
}

/**
 * Practice before the topic's activity opens: what it waits for (the lessons, setup, or the activity being written,
 * with its progress), and the way to the lessons.
 */
function Waiting({ topic, course, stale, retry }: { topic: TopicView; course: CourseView; stale?: unknown; retry: () => void }) {
  const { go } = useRouter();
  const why = topic.lessons.some((l) => l.state !== 'read') ? 'Practice opens after you finish the lessons.'
    : course.setup !== 'ready' ? 'Practice opens once setup is done.'
    : 'Practice opens here once your activity is written.';
  return (
    <main className="center">
      {/* Laid out as the topic page is, so the heading stays put on the way to the lessons. */}
      <div className="topic-page">
        <h1 className="h1 a-up">{topic.title}</h1>
        <p className="sub a-up" style={stagger(1)}>{why}</p>
        {course.setup === 'ready' && topic.activity === 'writing' && <Writing kind="author" concept={topic.id} label={topic.review ? 'Writing the review' : 'Writing the activity'} />}
        <div className="actions a-up" style={stagger(2)}>
          <Button onClick={() => go({ to: 'topic', topicId: topic.id })}>Go to the lessons</Button>
        </div>
      </div>
      {course.stalled && <Stalled stalled={course.stalled} work={course.stalledWork} retry={retry} />}
      {stale !== undefined && <Stale error={stale} retry={retry} />}
    </main>
  );
}

/**
 * Statement, editor, terminal and results, with Codemm beside them. Only Check is graded; Run and Try it never are.
 * The learner edits, Codemm explains.
 */
function Workspace({ activity, course, focus }: { activity: Activity; course: CourseView; focus: boolean }) {
  const api = useApi();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus && (!document.activeElement || document.activeElement === document.body)) title.current?.focus({ preventScroll: true });
  }, []);
  const { go, fail } = useRouter();
  const [open, setOpen] = useState(activity.files[0].path);
  const chat = useConversation({ activityId: activity.id }, 'Ask me if you get stuck.');
  const { add } = chat;
  const onReloaded = useCallback(() => add({ from: 'codemm', text: 'This file changed outside Codemm, so it was reloaded.' }), [add]);
  const { files, edit, save } = useLearnerFiles(activity, onReloaded);
  const topic = course.topics.find((t) => t.id === activity.concept);
  const terminal = useRef<TerminalHandle>(null);
  const program = useRun({ begin: (run) => api.runProgram(activity.id, run), command: activity.run, terminal, save, fail });
  // The pane is Run's alone: it appears with the first Run, and stays. Test results show in Results only.
  const [ran, setRan] = useState(false);

  // While a program runs, Results' Try again doesn't start an attempt either.
  const { shown, setShown, attempt } = useAttempt({ save, fail, blocked: () => program.running });

  const busy = shown.kind === 'busy' || program.running;
  // Codemm reads the saved files, so pending edits are saved before each question.
  const ask = (text: string) => chat.ask(text, save);

  const check = () =>
    attempt('Checking', async (run) => {
      const result = await api.check(activity.id, run);
      if (result.kind === 'not-counted') chat.add({ from: 'codemm', text: 'Your code is saved. Nothing was recorded.' });
      return { kind: 'check', result, keepTrying: false };
    });

  const tryIt = () => attempt('Running', async (run) => ({ kind: 'try', result: await api.tryIt(activity.id, run) }));

  async function act(work: () => Promise<void>, then: Parameters<typeof go>[0]) {
    try {
      await work();
      go(then);
    } catch (e) {
      fail(e);
    }
  }

  const lastLesson = topic?.lessons[topic.lessons.length - 1];
  const ways = {
    retry: () => (shown.kind === 'try' ? tryIt() : check()),
    keepTrying: () => shown.kind === 'check' && setShown({ ...shown, keepTrying: true }),
    reread: () => go(lastLesson ? { to: 'lesson', lessonId: lastLesson.id } : { to: 'learn' }),
    easier: () => act(() => api.easier(activity.concept), { to: 'learn' }),
    later: () => act(() => api.skip(activity.concept), { to: 'learn' }),
    computer: () => go({ to: 'computer', then: { to: 'practice', concept: activity.concept } }),
    tracks: () => go({ to: 'tracks' }),
    // Straight on to the topic Codemm offers now; a finished course shows its celebration. The same topic, or a review,
    // opens on Practice, which waits while its activity is written.
    next: async () => {
      try {
        const course = await api.course();
        const offered = course ? offeredTopic(course.topics) : undefined;
        if (!offered) go({ to: 'learn' });
        else go(offered.review || offered.id === activity.concept ? { to: 'practice', concept: offered.id } : continueRoute(offered));
      } catch (e) {
        fail(e);
      }
    },
  };

  return (
    <div className="ws">
      <section className="stmt" aria-labelledby="activity-title">
        {topic?.review === 'due' && <span className="pill" style={{ alignSelf: 'flex-start' }}>Review</span>}
        <h1 className="h2" id="activity-title" ref={title} tabIndex={-1}>{activity.title}</h1>
        <Markdown text={activity.statement} />
      </section>
      <div className="mid">
        <Editor
          files={files}
          open={open}
          onOpen={setOpen}
          onChange={(text) => edit(open, text)}
          tools={<>
            {activity.run && <RunButton running={program.running} disabled={busy} onStop={program.stop} onRun={() => (setRan(true), void program.start())} />}
            <Button variant="ghost" disabled={busy} onClick={tryIt}>Try it</Button>
            <Button disabled={busy} onClick={check}>Check</Button>
          </>}
        />
        {activity.run && ran && <Terminal ref={terminal} label={`Terminal for ${activity.title}`} status={program.status} onInput={program.input} onEnd={program.end} />}
        <Results shown={shown} name={course.track} topic={topic?.title ?? ''} visibleTests={activity.visibleTests} ways={ways} />
      </div>
      <Rail messages={chat.messages} onAsk={ask} busy={chat.busy} answering={chat.answering} name={course.track}>
        <div className="actions">
          <Button variant="ghost" disabled={chat.busy} onClick={() => ask('Give me a hint.')}>Hint</Button>
          <Button variant="ghost" disabled={chat.busy} onClick={() => ask('Show me where to look.')}>Show me</Button>
        </div>
      </Rail>
    </div>
  );
}
