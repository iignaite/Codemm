import { useEffect, useRef, useState } from 'react';
import type { Exercise, Note, SourceFile } from '../../../shared/api';
import { useApi, useLive } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button, Switch } from '../../ui/controls';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';
import { paletteFor } from '../../ui/palette';
import { Rail } from '../../ui/Rail';
import { Editor, type Mark } from './Editor';
import { Results, type ResultState } from './Results';

/** The practice workspace: statement, editor, results and the Codemm rail. */
export function Practice({ exerciseId }: { exerciseId: string }) {
  const api = useApi();
  const { go, courseId } = useNav();
  const course = useLive((a) => a.getCourse(courseId!), [courseId]);
  const [exercise, setExercise] = useState<Exercise>();
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [tab, setTab] = useState(0);
  const [result, setResult] = useState<ResultState>({ kind: 'idle' });
  const [notes, setNotes] = useState<Note[]>([{ from: 'codemm', text: 'Use what you just read.' }]);
  const [mark, setMark] = useState<Mark>();
  const [assist, setAssist] = useState(false);
  const [asking, setAsking] = useState(false);
  const lastRunGraded = useRef(true);

  useEffect(() => {
    api.getExercise(exerciseId).then((e) => {
      setExercise(e);
      setFiles(e.files);
      setAssist(e.assist);
    });
  }, [api, exerciseId]);

  const topic = course?.topics.find((t) => t.id === exercise?.topicId);
  const palette = course ? paletteFor(course.title) : undefined;
  if (!exercise || !topic) return <div className="ws" />;

  const say = (more: Note[]) => setNotes((n) => [...n, ...more]);

  async function run(graded: boolean) {
    lastRunGraded.current = graded;
    setResult({ kind: 'running' });
    const r = graded ? await api.check(exerciseId, files) : await api.test(exerciseId, files);
    setResult(r);
    if (r.kind === 'infra') say([{ from: 'codemm', text: 'Your code is saved. Nothing was recorded.' }]);
    if (r.kind !== 'graded') return;
    if (r.note) say([r.note]);
    const line = r.note?.line ?? mark?.line;
    setMark(line === undefined ? undefined : { line, good: r.passed === r.total });
  }

  async function ask(text: string) {
    say([{ from: 'you', text }]);
    say(await api.ask({ exercise: exerciseId }, text));
  }

  async function turnAssist(on: boolean) {
    await api.setAssist(on);
    setAssist(on);
    setAsking(false);
  }

  const lastLesson = topic.lessons.at(-1);

  return (
    <div className="ws">
      <section className="stmt" aria-label="Activity">
        <h1 className="h2">{exercise.title}</h1>
        <p className="sub" style={{ fontSize: 15 }}>{exercise.statement}</p>
        {exercise.example && <div className="card example">{exercise.example}</div>}
      </section>
      <div className="mid">
        <Editor files={files} tab={tab} onTab={setTab} mark={mark}
          onChange={(content) => {
            const next = files.map((f, i) => (i === tab ? { ...f, content } : f));
            setFiles(next);
            api.saveFiles(exerciseId, next);
          }}
          actions={<>
            <Button kind="ghost" disabled={result.kind === 'running'} onClick={() => run(false)}>Try it</Button>
            <Button disabled={result.kind === 'running'} onClick={() => run(true)}>Check</Button>
          </>} />
        <Results state={result} topic={topic.title} palette={palette}
          onRetry={() => run(lastRunGraded.current)}
          onContinue={() => go({ to: 'course' })}
          onLesson={() => lastLesson && go({ to: 'lesson', lessonId: lastLesson.id })}
          onEasier={() => ask('Try an easier one')}
          onLater={() => go({ to: 'course' })}
          onDismiss={() => setResult({ kind: 'idle' })} />
      </div>
      <Rail notes={notes} onAsk={ask} palette={palette}>
        <div className="help">
          <Button kind="ghost" onClick={async () => say([await api.hint(exerciseId)])}>Hint</Button>
          <Button kind="ghost" onClick={() => (assist ? ask('Show me') : setAsking(true))}>Show me</Button>
        </div>
        <Switch label="Assist" checked={assist} onChange={(on) => (on ? setAsking(true) : turnAssist(false))} />
      </Rail>
      {asking && (
        <Dialog title="Let Codemm edit this activity?" onClose={() => setAsking(false)}
          art={<Emm mood="look" width={110} perch={false} palette={palette} />}>
          <p className="sub">It counts for less. A similar one follows for you.</p>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <Button kind="ghost" size="lg" onClick={() => setAsking(false)}>Keep trying</Button>
            <Button size="lg" onClick={() => turnAssist(true)}>Let Codemm edit</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
