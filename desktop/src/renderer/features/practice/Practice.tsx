import { useCallback, useState } from 'react';
import type { Activity, CourseView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useConversation } from '../../app/useConversation';
import { useRouter } from '../../app/router';
import { Failed, Sidebar } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Markdown } from '../../ui/Markdown';
import { Rail } from '../../ui/Rail';
import { Editor } from './Editor';
import { Results, type Shown } from './Results';
import { useLearnerFiles } from './useLearnerFiles';

export function Practice({ concept }: { concept: string }) {
  const api = useApi();
  const { data, error, reload } = useLoad(async () => ({ activity: await api.activity(concept), course: (await api.course())! }), [concept]);
  if (error) return <><Sidebar slim /><Failed error={error} retry={reload} /></>;
  if (!data) return <Sidebar slim />;
  return <><Sidebar slim /><Workspace {...data} /></>;
}

/** Statement, editor and results, with Codemm beside them. Only Check is graded; the learner edits, Codemm explains. */
function Workspace({ activity, course }: { activity: Activity; course: CourseView }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [open, setOpen] = useState(activity.files[0].path);
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const chat = useConversation({ activityId: activity.id }, 'Use what you just read.');
  const { add } = chat;
  const onReloaded = useCallback(() => add({ from: 'codemm', text: 'This file changed outside Codemm, so it was reloaded.' }), [add]);
  const { files, edit, save } = useLearnerFiles(activity, onReloaded);
  const topic = course.topics.find((t) => t.id === activity.concept);
  const busy = shown.kind === 'busy';
  // Codemm reads the saved files, so pending edits are saved before each question.
  const ask = (text: string) => chat.ask(text, save);

  async function attempt(label: string, work: () => Promise<Shown>) {
    const before = shown;
    setShown({ kind: 'busy', label });
    // While the tests run, show how far they've got.
    const stop = api.onCheckProgress((progress) => setShown((s) => (s.kind === 'busy' ? { ...s, progress } : s)));
    try {
      await save();
      setShown(await work());
    } catch (e) {
      setShown(before);
      fail(e);
    } finally {
      stop();
    }
  }

  const check = () =>
    attempt('Checking', async () => {
      const result = await api.check(activity.id);
      if (result.kind === 'not-counted') chat.add({ from: 'codemm', text: 'Your code is saved. Nothing was recorded.' });
      return { kind: 'check', result, keepTrying: false };
    });

  const tryIt = () => attempt('Running', async () => ({ kind: 'try', result: await api.tryIt(activity.id) }));

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
    next: () => go({ to: 'learn' }),
  };

  return (
    <div className="ws">
      <section className="stmt" aria-labelledby="activity-title">
        <h1 className="h2" id="activity-title">{activity.title}</h1>
        <Markdown text={activity.statement} />
      </section>
      <div className="mid">
        <Editor
          files={files}
          open={open}
          onOpen={setOpen}
          onChange={(text) => edit(open, text)}
          tools={<>
            <Button variant="ghost" disabled={busy} onClick={tryIt}>Try it</Button>
            <Button disabled={busy} onClick={check}>Check</Button>
          </>}
        />
        <Results shown={shown} name={course.track} topic={topic?.title ?? ''} visibleTests={activity.visibleTests} ways={ways} />
      </div>
      <Rail messages={chat.messages} onAsk={ask} busy={chat.busy} name={course.track}>
        <div className="actions">
          <Button variant="ghost" disabled={chat.busy} onClick={() => ask('Give me a hint.')}>Hint</Button>
          <Button variant="ghost" disabled={chat.busy} onClick={() => ask('Show me where to look.')}>Show me</Button>
        </div>
      </Rail>
    </div>
  );
}
