import { useState } from 'react';
import type { Course, Lesson as LessonData, Topic } from '../../../shared/api';
import { useApi } from '../../app/api';
import { cacheFor } from '../../app/cache';
import { useConversation } from '../../app/useConversation';
import { useRouter, type Route } from '../../app/router';
import { Failed, Sidebar } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { Rail } from '../../ui/Rail';
import { NoteEditor } from './NoteEditor';
import { Outline } from './Outline';
import { Predict } from './Predict';

function neighbours(topic: Topic, lessonId: string): { prev: Route; next: (course: Course) => Route } {
  const at = topic.lessons.findIndex((l) => l.id === lessonId);
  const back: Route = { to: 'topic', topicId: topic.id };
  return {
    prev: at > 0 ? { to: 'lesson', lessonId: topic.lessons[at - 1].id } : back,
    next: (course) => {
      const fresh = course.topics.find((t) => t.id === topic.id)!;
      const after = fresh.lessons[at + 1];
      if (after && after.state !== 'writing') return { to: 'lesson', lessonId: after.id };
      if (!after && fresh.activity.state === 'open') return { to: 'practice', activityId: fresh.activity.id };
      return back;
    },
  };
}

interface View {
  lesson: LessonData;
  course: Course;
  topic: Topic;
}

/** Predict first, then see it. The learner can keep a note on the lesson. Reopens instantly from the cache. */
export function Lesson({ lessonId }: { lessonId: string }) {
  const api = useApi();
  const cache = cacheFor<View>(api, 'lessons');
  const { data, error, reload } = useLoad(async () => {
    const version = cache.version();
    const lesson = await api.lesson(lessonId);
    const course = (await api.course())!;
    const view = { lesson, course, topic: course.topics.find((t) => t.id === lesson.topicId)! };
    cache.set(lessonId, view, version);
    return view;
  }, [lessonId]);
  const view = data ?? cache.get(lessonId);
  // A saved note makes every cached copy stale; read again.
  const onSaved = () => {
    cache.clear();
    reload();
  };
  if (view) return <><Sidebar slim /><Reader {...view} onSaved={onSaved} /></>;
  if (error) return <><Sidebar slim /><Failed retry={reload} /></>;
  return <Sidebar slim />;
}

function Reader({ lesson, course, topic, onSaved }: View & { onSaved: () => void }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [saved, setSaved] = useState<string>();
  const note = saved ?? lesson.note;
  const [editing, setEditing] = useState(false);
  const chat = useConversation({ lessonId: lesson.id }, 'Ask about anything here.');
  const { prev, next } = neighbours(topic, lesson.id);

  async function save(text: string) {
    try {
      await api.saveNote(lesson.id, text);
      setSaved(text);
      onSaved();
      setEditing(false);
    } catch (e) {
      fail(e);
    }
  }

  async function onNext() {
    try {
      await api.read(lesson.id);
      go(next((await api.course())!));
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="ws lesson">
      <Outline topic={topic} current={lesson.id} />
      <main className="reader">
        <div className="head">
          <h1 className="h1 a-up">{lesson.title}</h1>
          {!editing && (
            <Button variant="ghost" className="a-up" style={stagger(1)} onClick={() => setEditing(true)}>
              <Icon name="pencil" color="#0E2754" size={17} />
              Edit
            </Button>
          )}
        </div>
        <p className="sub a-up" style={stagger(2)}>{lesson.summary}</p>
        {lesson.code && <pre className="pre a-up" style={stagger(3)}>{lesson.code}</pre>}
        {lesson.predict && <Predict predict={lesson.predict} />}
        {editing ? (
          <NoteEditor note={note} onSave={save} onCancel={() => setEditing(false)} />
        ) : (
          note && (
            <div className="my-note a-up" style={stagger(5)}>
              <Icon name="pencil" color="#7A5C00" size={17} />
              <span><b>My note:</b> {note}</span>
            </div>
          )
        )}
        <div className="actions a-up" style={stagger(6)}>
          <Button variant="ghost" size="lg" onClick={() => go(prev)}>Previous</Button>
          <Button size="lg" onClick={onNext}>Next</Button>
        </div>
      </main>
      <Rail messages={chat.messages} onAsk={chat.ask} name={course.track} />
    </div>
  );
}
