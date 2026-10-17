import { useEffect, useState } from 'react';
import type { Lesson, Note, Predict as PredictData } from '../../../shared/api';
import { useApi, useLive } from '../../app/api';
import { activityOpen, useNav } from '../../app/nav';
import { Button, Chip, Field } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { paletteFor } from '../../ui/palette';
import { Rail } from '../../ui/Rail';

function Predict({ predict }: { predict: PredictData }) {
  const [picked, setPicked] = useState<number>();
  return (
    <section className="card predict a-up" style={stagger(4)} aria-label="Predict">
      <b style={{ fontSize: 16 }}>{predict.question}</b>
      <div className="row-actions" role="group" aria-label="Your answer">
        {predict.options.map((o, i) => (
          <Chip key={o} pressed={picked === i} onClick={() => setPicked(i)} style={{ minWidth: 64 }}>
            {picked !== undefined && i === predict.answer && <Icon name="check" color="#0E7C35" size={13} />}{o}
          </Chip>
        ))}
      </div>
      <output className="shown" hidden={picked === undefined}>{picked !== undefined && <span className="a-up">{predict.shown}</span>}</output>
    </section>
  );
}

function Editor({ lesson, onSave, onCancel }: { lesson: Lesson; onSave: (body: string, note: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(lesson.body);
  const [note, setNote] = useState(lesson.note);
  return (
    <form style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }} onSubmit={(e) => { e.preventDefault(); onSave(body, note); }}>
      <textarea className="field" aria-label="Lesson" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      <Field aria-label="My note" placeholder="My note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row-actions"><Button type="submit">Save</Button><Button kind="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

/** Predict first, then see it. The learner can edit the lesson or add notes. */
export function LessonPage({ lessonId }: { lessonId: string }) {
  const api = useApi();
  const { go, courseId } = useNav();
  const course = useLive((a) => a.getCourse(courseId!), [courseId]);
  const [lesson, setLesson] = useState<Lesson>();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState<Note[]>([{ from: 'codemm', text: 'Ask about anything here.' }]);

  useEffect(() => {
    api.openLesson(lessonId).then(setLesson);
  }, [api, lessonId]);

  const topic = course?.topics.find((t) => t.id === lesson?.topicId);
  if (!lesson || !topic || !course) return <div className="ws lesson-ws" />;
  const at = topic.lessons.findIndex((l) => l.id === lessonId);
  const prev = topic.lessons[at - 1];
  const next = topic.lessons[at + 1];
  const open = activityOpen(topic);

  async function save(body: string, note: string) {
    setLesson(await api.saveLesson(lessonId, { body, note }));
    setEditing(false);
  }

  async function ask(text: string) {
    setNotes((n) => [...n, { from: 'you', text }]);
    const reply = await api.ask({ lesson: lessonId }, text);
    setNotes((n) => [...n, ...reply]);
  }

  return (
    <div className="ws lesson-ws">
      <nav className="stmt lnav" aria-label={topic.title}>
        <h2 className="h3">{topic.title}</h2>
        {topic.lessons.map((l) => (
          <button key={l.id} type="button" className="litem" aria-current={l.id === lessonId ? 'page' : undefined}
            disabled={l.state === 'writing'} onClick={() => go({ to: 'lesson', lessonId: l.id })}>
            <Icon name="book" color={l.id === lessonId ? '#0E7C35' : '#4A5B7A'} size={18} />
            <span style={{ flex: 1 }}>{l.title}</span>
            {l.state === 'read' && l.id !== lessonId && <Icon name="check" color="#0E7C35" size={14} />}
          </button>
        ))}
        <button type="button" className="litem" disabled={!open} onClick={() => go({ to: 'practice', exerciseId: topic.activity! })}>
          <Icon name="code" color="#0E2754" size={18} /><span style={{ flex: 1 }}>Activity</span>
          {!open && <Icon name="lock" color="#5B6A84" size={14} />}
        </button>
      </nav>
      <main className="lmain">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 className="h1 a-up" style={{ fontSize: 38 }}>{lesson.title}</h1>
          {!editing && <Button kind="ghost" className="a-up" style={stagger(1)} onClick={() => setEditing(true)}><Icon name="pencil" color="#0E2754" size={17} />Edit</Button>}
        </div>
        {editing
          ? <Editor lesson={lesson} onSave={save} onCancel={() => setEditing(false)} />
          : <>
            <p className="sub a-up" style={{ ...stagger(2), fontSize: 18, maxWidth: 580 }}>{lesson.body}</p>
            {lesson.code && <pre className="pre a-up" style={{ ...stagger(3), fontSize: 15, padding: '18px 20px' }}>{lesson.code}</pre>}
            {lesson.predict && <Predict predict={lesson.predict} />}
            {lesson.note && (
              <div className="mynote a-up" style={stagger(5)}>
                <Icon name="pencil" color="#7A5C00" size={17} /><span><b>My note:</b> {lesson.note}</span>
              </div>
            )}
          </>}
        <div className="row-actions a-up" style={{ ...stagger(6), marginTop: 'auto' }}>
          <Button kind="ghost" size="lg" onClick={() => go(prev ? { to: 'lesson', lessonId: prev.id } : { to: 'topic', topicId: topic.id })}>Previous</Button>
          <Button size="lg" disabled={next?.state === 'writing'} onClick={() => go(
            next ? { to: 'lesson', lessonId: next.id } : open ? { to: 'practice', exerciseId: topic.activity! } : { to: 'topic', topicId: topic.id },
          )}>Next</Button>
        </div>
      </main>
      <Rail notes={notes} onAsk={ask} palette={paletteFor(course.title)} />
    </div>
  );
}
