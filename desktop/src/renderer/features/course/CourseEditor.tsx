import { useRef, useState, type FormEvent } from 'react';
import type { Draft, DraftTopic } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button, Field } from '../../ui/controls';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { stagger } from '../../ui/motion';
import { paletteFor } from '../../ui/palette';

function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Rename, reorder, add or remove topics. Moving works without dragging. */
export function CourseEditor({ draft }: { draft: Draft }) {
  const api = useApi();
  const { go, openCourse } = useNav();
  const [topics, setTopics] = useState<DraftTopic[]>(draft.topics);
  const [editing, setEditing] = useState<string>();
  const [request, setRequest] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const dragged = useRef<number>(null);
  const current = (): Draft => ({ ...draft, topics });

  const rename = (id: string, title: string) => setTopics((ts) => ts.map((t) => (t.id === id ? { ...t, title } : t)));
  const remove = (id: string) => setTopics((ts) => ts.filter((t) => t.id !== id));

  function done() {
    setTopics((ts) => ts.filter((t) => t.title.trim()));
    setEditing(undefined);
  }

  function add() {
    const id = crypto.randomUUID();
    setTopics((ts) => [...ts, { id, title: '' }]);
    setEditing(id);
  }

  async function revise(e: FormEvent) {
    e.preventDefault();
    const text = request.trim();
    if (!text) return;
    setBusy(true);
    const next = await api.reviseDraft(current(), text).finally(() => setBusy(false));
    setTopics(next.topics);
    setRequest('');
  }

  async function approve() {
    setBusy(true);
    const course = await api.approveDraft(current()).finally(() => setBusy(false));
    openCourse(course.id);
    go({ to: 'topic', topicId: course.topics[0].id });
  }

  return (
    <main className="main" style={{ padding: '40px 0', alignItems: 'center' }}>
      <div style={{ width: 720, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 className="h2 a-up">{draft.title}</h1>
        <ol className="topics">
          {topics.map((t, i) => (
            <li key={t.id} className={`card topic a-up ${editing === t.id ? 'editing' : ''}`} style={stagger(i, 100)}
              draggable={editing !== t.id}
              onDragStart={() => { dragged.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragged.current !== null) setTopics((ts) => moved(ts, dragged.current!, i)); dragged.current = null; }}>
              <Menu label={`Move ${t.title || 'topic'}`} button={<Icon name="grip" color="#8492A9" size={17} />} items={[
                { label: 'Move up', disabled: i === 0, onSelect: () => setTopics((ts) => moved(ts, i, i - 1)) },
                { label: 'Move down', disabled: i === topics.length - 1, onSelect: () => setTopics((ts) => moved(ts, i, i + 1)) },
              ]} />
              <span className="num">{i + 1}</span>
              {editing === t.id
                ? <>
                  <input aria-label="Topic name" value={t.title} autoFocus onChange={(e) => rename(t.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(); } }} />
                  <Button kind="text" onClick={done}>Done</Button>
                </>
                : <>
                  <span className="topic-title">{t.title}</span>
                  <button type="button" className="ibtn" aria-label={`Rename ${t.title}`} onClick={() => setEditing(t.id)}><Icon name="pencil" color="#5B6A84" size={17} /></button>
                  <button type="button" className="ibtn" aria-label={`Remove ${t.title}`} onClick={() => remove(t.id)}><Icon name="x" color="#5B6A84" size={13} /></button>
                </>}
            </li>
          ))}
        </ol>
        <button type="button" className="add a-up" style={stagger(topics.length + 1, 100)} onClick={add}>
          <Icon name="plus" color="#0E2754" size={16} />Add a topic
        </button>
        <div className="composer a-up" style={{ ...stagger(topics.length + 2, 100), marginTop: 10 }}>
          <form onSubmit={revise} style={{ flex: 1 }}>
            <Field aria-label="Ask Codemm for changes" placeholder="Ask Codemm for changes" value={request} onChange={(e) => setRequest(e.target.value)} />
          </form>
          <Button size="lg" disabled={busy || !topics.length} onClick={() => (draft.needsSetup ? setAsking(true) : approve())}>Approve</Button>
        </div>
      </div>
      {asking && (
        <Dialog title={`Set up ${draft.track} on this computer?`} onClose={() => setAsking(false)}
          art={<Emm mood="look" width={150} palette={paletteFor(draft.title)} />}>
          <p className="sub">Downloads once. Graded runs are offline.</p>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <Button kind="ghost" size="lg" onClick={() => setAsking(false)}>Not now</Button>
            <Button size="lg" disabled={busy} onClick={approve}>Set up</Button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
