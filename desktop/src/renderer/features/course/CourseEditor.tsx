import { useRef, useState, type FormEvent } from 'react';
import type { Concept, Roadmap } from '../../../shared/api';
import { addTopic, moveTopic, removeTopic, renameTopic } from '../../../shared/roadmap';
import { useApi } from '../../app/api';
import { cacheFor } from '../../app/cache';
import { useJob } from '../../app/useJob';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { JobBar } from '../../ui/JobBar';
import { stagger } from '../../ui/motion';
import { TopicItem } from './TopicItem';

/** Rename, reorder, add or remove topics, or ask Codemm for changes. Then approve (§4.2). */
export function CourseEditor({ roadmap }: { roadmap: Roadmap }) {
  const api = useApi();
  const { go, fail } = useRouter();
  const [concepts, setConcepts] = useState(roadmap.concepts);
  const [sources, setSources] = useState(roadmap.sources);
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const [request, setRequest] = useState('');
  const [asking, setAsking] = useState(false);
  const dragFrom = useRef<string>(undefined);
  // "Ask Codemm for changes" and Go deeper run a roadmap-change job (§4.11).
  const job = useJob((p) => p.kind === 'roadmap', []);

  /** Applies an edit, or says why it was refused. */
  function edit(change: (cs: Concept[]) => Concept[]) {
    try {
      setConcepts(change(concepts));
      setNotice('');
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  function rename(id: string, title: string) {
    if (title) edit((cs) => renameTopic(cs, id, title));
    setEditing(undefined);
  }

  function add(title: string) {
    if (title) edit((cs) => addTopic(cs, title));
    setAdding(false);
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (request.trim()) await change(request.trim());
  }

  /** "Go deeper": the same roadmap change, asking to split one topic into its smaller skills. */
  function deeper(title: string) {
    if (!asking) void change(`Go deeper on "${title}": split it into the smaller skills it needs, each its own topic with its prerequisites.`);
  }

  async function change(text: string) {
    setAsking(true);
    try {
      const result = await api.reviseRoadmap(concepts, text);
      setConcepts(result.roadmap.concepts);
      setSources(result.roadmap.sources);
      setNotice(result.changed ? '' : result.text || 'No change.');
      setRequest('');
    } catch (err) {
      // Come back to the edited roadmap, not the one this screen opened with.
      fail(err, { to: 'course', roadmap: { ...roadmap, concepts, sources } });
    } finally {
      setAsking(false);
    }
  }

  async function approve() {
    try {
      await api.approve(concepts);
      // A new course reuses lesson ids, so cached lessons belong to the old one.
      cacheFor(api, 'lessons').clear();
      const now = (await api.course())?.topics.find((t) => t.state === 'now');
      go(now ? { to: 'topic', topicId: now.id } : { to: 'learn' });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <main className="main" style={{ padding: '40px 0', alignItems: 'center' }}>
      <div className="stack" style={{ width: 720, gap: 10 }}>
        <h1 className="h2 a-up">{roadmap.goal}</h1>
        <ol className="topics">
          {concepts.map((c, i) => (
            <TopicItem
              key={c.id}
              index={i}
              count={concepts.length}
              title={c.title}
              editing={editing === c.id}
              onEdit={() => setEditing(c.id)}
              onRename={(title) => rename(c.id, title)}
              onRemove={() => edit((cs) => removeTopic(cs, c.id))}
              onDeeper={() => deeper(c.title)}
              onMove={(to) => edit((cs) => moveTopic(cs, c.id, to))}
              onDragStart={() => (dragFrom.current = c.id)}
              onDrop={() => dragFrom.current && edit((cs) => moveTopic(cs, dragFrom.current!, i))}
            />
          ))}
          {adding && <TopicItem index={concepts.length} count={concepts.length + 1} title="" editing onEdit={() => {}} onRename={add} />}
        </ol>
        {asking && job && <JobBar job={job} label="Changing the roadmap" />}
        <p className="alert" role="status">{notice}</p>
        <button className="add a-up" type="button" style={stagger(0, 100)} disabled={adding} onClick={() => setAdding(true)}>
          <Icon name="plus" color="#0E2754" size={16} />
          Add a topic
        </button>
        <form className="composer a-up" style={{ ...stagger(1, 100), marginTop: 10 }} onSubmit={ask}>
          <Field aria-label="Ask Codemm for changes" placeholder="Ask Codemm for changes" value={request} disabled={asking} onChange={(e) => setRequest(e.target.value)} />
          <Button size="lg" disabled={concepts.length === 0 || editing !== undefined || adding || asking} onClick={approve}>Approve</Button>
        </form>
        {sources.length > 0 && (
          <section className="sources a-up" style={stagger(2, 100)} aria-labelledby="sources-t">
            <h2 className="h3" id="sources-t">Sources</h2>
            <ul>
              {sources.map((s) => (
                <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
