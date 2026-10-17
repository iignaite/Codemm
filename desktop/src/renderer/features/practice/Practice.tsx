import { useEffect, useRef, useState } from 'react';
import type { Activity, CodeFile, Course } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useConversation } from '../../app/useConversation';
import { useRouter } from '../../app/router';
import { Failed, Sidebar } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';
import { Rail } from '../../ui/Rail';
import { Switch } from '../../ui/Switch';
import { Editor } from './Editor';
import { Results, type Shown } from './Results';

export function Practice({ activityId }: { activityId: string }) {
  const api = useApi();
  const { data, error, reload } = useLoad(async () => ({ activity: await api.activity(activityId), course: (await api.course())! }), [activityId]);
  if (error) return <><Sidebar slim /><Failed retry={reload} /></>;
  if (!data) return <Sidebar slim />;
  return <><Sidebar slim /><Workspace {...data} /></>;
}

const SAVE_MS = 400;

/** Saves unchecked edits shortly after typing stops, and when the learner leaves. */
function useDraft(activityId: string, files: CodeFile[], loaded: CodeFile[]) {
  const api = useApi();
  const latest = useRef({ files, saved: true });
  useEffect(() => {
    if (files === loaded) return;
    latest.current = { files, saved: false };
    const timer = setTimeout(() => {
      latest.current.saved = true;
      void api.save(activityId, files).catch(console.error);
    }, SAVE_MS);
    return () => clearTimeout(timer);
  }, [api, activityId, files, loaded]);
  useEffect(
    () => () => {
      if (!latest.current.saved) void api.save(activityId, latest.current.files).catch(console.error);
    },
    [api, activityId],
  );
}

/** Statement, editor and results, with Codemm beside them. Only Check is graded. */
function Workspace({ activity: initial, course }: { activity: Activity; course: Course }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [activity, setActivity] = useState(initial);
  const [files, setFiles] = useState(initial.files);
  const [open, setOpen] = useState(initial.files[0].path);
  const [shown, setShown] = useState<Shown>({ kind: 'idle' });
  const [confirm, setConfirm] = useState(false);
  const chat = useConversation({ activityId: activity.id }, 'Use what you just read.');
  const topic = course.topics.find((t) => t.id === activity.topicId);
  const line = [...chat.messages].reverse().find((m) => m.line !== undefined)?.line;
  const busy = shown.kind === 'busy';
  useDraft(activity.id, files, initial.files);

  async function attempt(label: string, work: () => Promise<Shown>) {
    const before = shown;
    setShown({ kind: 'busy', label });
    try {
      setShown(await work());
    } catch (e) {
      setShown(before);
      fail(e);
    }
  }

  const check = (current = files) =>
    attempt('Checking', async () => {
      const result = await api.check(activity.id, current);
      if (result.kind === 'not-counted') chat.add({ from: 'codemm', text: 'Your code is saved. Nothing was recorded.' });
      return { kind: 'check', result, keepTrying: false };
    });

  const run = () => attempt('Running', async () => ({ kind: 'run', ...(await api.run(activity.id, files)) }));

  async function help(kind: 'hint' | 'show') {
    try {
      chat.add(await api.help(activity.id, kind));
    } catch (e) {
      fail(e);
    }
  }

  async function setAssist(on: boolean) {
    if (on) return setConfirm(true);
    try {
      setActivity(await api.assist(activity.id, false));
    } catch (e) {
      fail(e);
    }
  }

  async function letCodemmEdit() {
    setConfirm(false);
    try {
      await api.save(activity.id, files);
      const edited = await api.assist(activity.id, true);
      setActivity(edited);
      setFiles(edited.files);
      await check(edited.files);
    } catch (e) {
      fail(e);
    }
  }

  async function easier() {
    try {
      go({ to: 'practice', activityId: await api.easier(activity.id) });
    } catch (e) {
      fail(e);
    }
  }

  const lastLesson = topic?.lessons[topic.lessons.length - 1];
  const ways = {
    retry: () => check(),
    keepTrying: () => shown.kind === 'check' && setShown({ ...shown, keepTrying: true }),
    reread: () => go(lastLesson ? { to: 'lesson', lessonId: lastLesson.id } : { to: 'learn' }),
    easier,
    later: () => go({ to: 'learn' }),
    computer: () => go({ to: 'computer', then: { to: 'practice', activityId: activity.id } }),
    next: () => go({ to: 'learn' }),
  };

  return (
    <div className="ws">
      <section className="stmt" aria-labelledby="activity-title">
        <h1 className="h2" id="activity-title">{activity.title}</h1>
        <p className="sub" style={{ fontSize: 15 }}>{activity.prompt}</p>
        {activity.example && <div className="card example">{activity.example}</div>}
      </section>
      <div className="mid">
        <Editor
          files={files}
          open={open}
          line={open === files[0].path ? line : undefined}
          onOpen={setOpen}
          onChange={(text) => setFiles((fs) => fs.map((f) => (f.path === open ? { ...f, text } : f)))}
          tools={<>
            <Button variant="ghost" disabled={busy} onClick={run}>Try it</Button>
            <Button disabled={busy} onClick={() => check()}>Check</Button>
          </>}
        />
        <Results shown={shown} name={course.track} ways={ways} />
      </div>
      <Rail messages={chat.messages} onAsk={chat.ask} name={course.track}>
        <div className="actions">
          <Button variant="ghost" onClick={() => help('hint')}>Hint</Button>
          <Button variant="ghost" onClick={() => help('show')}>Show me</Button>
        </div>
        <Switch label="Assist" checked={activity.assist} onChange={setAssist} />
      </Rail>
      {confirm && (
        <Dialog
          title="Let Codemm edit this activity?"
          text="It counts for less. A similar one follows for you."
          art={<Emm mood="look" width={110} name={course.track} />}
          onClose={() => setConfirm(false)}
        >
          <Button variant="ghost" size="lg" onClick={() => setConfirm(false)}>Keep trying</Button>
          <Button size="lg" onClick={letCodemmEdit}>Let Codemm edit</Button>
        </Dialog>
      )}
    </div>
  );
}
