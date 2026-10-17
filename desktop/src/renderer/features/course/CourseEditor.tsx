import { useRef, useState, type FormEvent } from 'react';
import type { Draft } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Emm } from '../../ui/Emm';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { TopicItem } from './TopicItem';

interface Item {
  key: number;
  title: string;
}

let nextKey = 0;
const items = (titles: string[]): Item[] => titles.map((title) => ({ key: nextKey++, title }));

/** Rename, reorder, add or remove topics, or ask Codemm for changes. Then approve. */
export function CourseEditor({ draft }: { draft: Draft }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [topics, setTopics] = useState(() => items(draft.topics));
  const [editing, setEditing] = useState<number>();
  const [request, setRequest] = useState('');
  const [asking, setAsking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dragFrom = useRef<number>(undefined);
  const current = (): Draft => ({ ...draft, topics: topics.map((t) => t.title) });

  function move(from: number, to: number) {
    if (to < 0 || to >= topics.length) return;
    const next = [...topics];
    next.splice(to, 0, ...next.splice(from, 1));
    setTopics(next);
  }

  function rename(key: number, title: string) {
    setTopics((ts) => (title ? ts.map((t) => (t.key === key ? { ...t, title } : t)) : ts.filter((t) => t.key !== key)));
    setEditing(undefined);
  }

  function add() {
    const [item] = items(['']);
    setTopics((ts) => [...ts, item]);
    setEditing(item.key);
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!request.trim()) return;
    setAsking(true);
    try {
      setTopics(items((await api.revise(current(), request.trim())).topics));
      setRequest('');
    } catch (err) {
      fail(err);
    } finally {
      setAsking(false);
    }
  }

  async function approve() {
    setConfirm(false);
    try {
      const course = await api.approve(current());
      go({ to: 'topic', topicId: course.topics[0].id });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <main className="main" style={{ padding: '40px 0', alignItems: 'center' }}>
      <div className="stack" style={{ width: 720, gap: 10 }}>
        <h1 className="h2 a-up">{draft.title}</h1>
        <ol className="topics">
          {topics.map((t, i) => (
            <TopicItem
              key={t.key}
              index={i}
              count={topics.length}
              title={t.title}
              editing={editing === t.key}
              onEdit={() => setEditing(t.key)}
              onRename={(title) => rename(t.key, title)}
              onRemove={() => setTopics((ts) => ts.filter((x) => x.key !== t.key))}
              onMove={(to) => move(i, to)}
              onDragStart={() => (dragFrom.current = i)}
              onDrop={() => dragFrom.current !== undefined && move(dragFrom.current, i)}
            />
          ))}
        </ol>
        <button className="add a-up" type="button" style={stagger(0, 100)} onClick={add}>
          <Icon name="plus" color="#0E2754" size={16} />
          Add a topic
        </button>
        <form className="composer a-up" style={{ ...stagger(1, 100), marginTop: 10 }} onSubmit={ask}>
          <Field aria-label="Ask Codemm for changes" placeholder="Ask Codemm for changes" value={request} disabled={asking} onChange={(e) => setRequest(e.target.value)} />
          <Button size="lg" disabled={topics.length === 0 || editing !== undefined || asking} onClick={() => (draft.installed ? approve() : setConfirm(true))}>Approve</Button>
        </form>
      </div>
      {confirm && (
        <Dialog
          title={`Set up ${draft.track} on this computer?`}
          text="Downloads once. Graded runs are offline."
          art={<Emm mood="look" width={150} name={draft.track} perch />}
          onClose={() => setConfirm(false)}
        >
          <Button variant="ghost" size="lg" onClick={() => setConfirm(false)}>Not now</Button>
          <Button size="lg" onClick={approve}>Set up</Button>
        </Dialog>
      )}
    </main>
  );
}
