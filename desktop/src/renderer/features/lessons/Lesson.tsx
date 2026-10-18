import { useState } from 'react';
import type { CourseView, Lesson as LessonData, TopicView } from '../../../shared/api';
import { useApi } from '../../app/api';
import { lessonCache } from '../../app/cache';
import { useBusy } from '../../app/useBusy';
import { useConversation } from '../../app/useConversation';
import { useRouter, type Route } from '../../app/router';
import { settled } from '../../app/course';
import { Failed, Stale, Stalled } from '../../app/Problems';
import { Sidebar } from '../../app/Sidebar';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { lessonParts } from '../../ui/Markdown';
import { stagger } from '../../ui/motion';
import { Rail } from '../../ui/Rail';
import { Example } from './Example';
import { NoteEditor } from './NoteEditor';
import { Outline } from './Outline';
import { SetupOffer } from './SetupConsent';

function neighbours(topic: TopicView, lessonId: string): { prev: Route; next: (course: CourseView) => Route } {
  const at = topic.lessons.findIndex((l) => l.id === lessonId);
  const back: Route = { to: 'topic', topicId: topic.id };
  return {
    prev: at > 0 ? { to: 'lesson', lessonId: topic.lessons[at - 1].id } : back,
    next: (course) => {
      const fresh = course.topics.find((t) => t.id === topic.id)!;
      const after = fresh.lessons[at + 1];
      if (after && after.state !== 'writing') return { to: 'lesson', lessonId: after.id };
      if (!after && fresh.activity === 'open') return { to: 'practice', concept: topic.id };
      return back;
    },
  };
}

interface View {
  lesson: LessonData;
  course: CourseView;
  topic: TopicView;
}

/** A static lesson with the learner's notes. Reopens instantly from the cache (§4.3). */
export function Lesson({ lessonId }: { lessonId: string }) {
  const api = useApi();
  const cache = lessonCache<View>(api);
  // Keeps reading while the topic's work is pending, so a stall shows here too (§5).
  const { data, error, stale, reload } = useLoad(async () => {
    const version = cache.version();
    const lesson = await api.lesson(lessonId);
    const course = (await api.course())!;
    const view = { lesson, course, topic: course.topics.find((t) => t.id === lesson.concept)! };
    cache.set(lessonId, view, version);
    return view;
  }, [lessonId], { settled: (v) => settled(v.course) });
  const view = data ?? cache.get(lessonId);
  // Saved notes and restarted work make every cached copy stale; read again.
  const refresh = () => {
    cache.clear();
    reload();
  };
  if (view) {
    return (
      <>
        <Sidebar slim />
        <Reader {...view} onSaved={refresh} />
        {view.course.stalled && <Stalled stalled={view.course.stalled} retry={refresh} />}
        {stale !== undefined && <Stale error={stale} retry={reload} />}
      </>
    );
  }
  if (error) return <><Sidebar slim /><Failed error={error} retry={reload} /></>;
  return <Sidebar slim />;
}

function Reader({ lesson, course, topic, onSaved }: View & { onSaved: () => void }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [saved, setSaved] = useState<string>();
  const notes = saved ?? lesson.notes;
  const [editing, setEditing] = useState(false);
  const chat = useConversation({ lessonId: lesson.id }, 'Ask about anything here.');
  const { prev, next } = neighbours(topic, lesson.id);

  async function save(text: string) {
    try {
      await api.saveNotes(lesson.id, text);
      setSaved(text);
      onSaved();
      setEditing(false);
    } catch (e) {
      fail(e);
    }
  }

  // Marking the lesson read takes a moment: Next runs once, and waits meanwhile.
  const moving = useBusy();
  const onNext = () =>
    moving.guard(async () => {
      try {
        await api.markRead(lesson.id);
        go(next((await api.course())!));
      } catch (e) {
        fail(e);
      }
    });

  return (
    <div className="ws lesson">
      <Outline topic={topic} current={lesson.id} />
      <main className="reader">
        {/* Setup waits for the learner's OK; reading doesn't wait for setup (§4.1). */}
        <SetupOffer course={course} banner onChange={onSaved} />
        <div className="head">
          <h1 className="h1 a-up">{lesson.title}</h1>
          {!editing && (
            <Button variant="ghost" className="a-up" style={stagger(1)} onClick={() => setEditing(true)}>
              <Icon name="pencil" color="var(--ink)" size={17} />
              {notes ? 'Edit note' : 'Add a note'}
            </Button>
          )}
        </div>
        <div className="a-up">
          {lessonParts(lesson.markdown, true).map((part, i) =>
            'example' in part ? <Example key={i} lesson={lesson} index={part.example} /> : <div key={i} className="md" dangerouslySetInnerHTML={{ __html: part.html }} />,
          )}
        </div>
        {editing ? (
          <NoteEditor note={notes} onSave={save} onCancel={() => setEditing(false)} />
        ) : (
          notes && (
            <div className="my-note a-up" style={stagger(5)}>
              <Icon name="pencil" color="var(--note-ink)" size={17} />
              <span><b>My note:</b> {notes}</span>
            </div>
          )
        )}
        <div className="actions a-up" style={stagger(6)}>
          <Button variant="ghost" size="lg" onClick={() => go(prev)}>Previous</Button>
          <Button size="lg" disabled={moving.busy} onClick={onNext}>Next</Button>
        </div>
      </main>
      <Rail messages={chat.messages} onAsk={(text) => chat.ask(text)} busy={chat.busy} answering={chat.answering} name={course.track} />
    </div>
  );
}
