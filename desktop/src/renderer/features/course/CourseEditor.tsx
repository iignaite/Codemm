import { useRef, useState, type FormEvent } from 'react';
import type { Concept, Roadmap } from '../../../shared/api';
import { addTopic, moveTopic, removeTopic, renameTopic } from '../../../shared/roadmap';
import { useApi } from '../../app/api';
import { cacheFor, lessonCache } from '../../app/cache';
import { useJob } from '../../app/useJob';
import { useRouter } from '../../app/router';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { JobBar } from '../../ui/JobBar';
import { stagger } from '../../ui/motion';
import { TopicItem } from './TopicItem';
import { ExternalLink } from '../../ui/ExternalLink';
import { Limit } from '../../ui/Limit';
import { LIMITS } from '../../../shared/limits';

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

  /** Applies an edit and saves it, so the draft survives leaving or closing Codemm; or says why it was refused. */
  function edit(change: (cs: Concept[]) => Concept[]) {
    if (asking) return;
    let next: Concept[];
    try {
      next = change(concepts);
    } catch (e) {
      setNotice((e as Error).message);
      return;
    }
    setConcepts(next);
    setNotice('');
    api.saveDraft(next).catch((err: unknown) => fail(err, { to: 'course', roadmap: { ...roadmap, concepts: next, sources } }));
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

  /**
   * "Go deeper": the same roadmap change, asking to split one topic into its smaller skills. The topic keeps the
   * learner's title: an agent that retitles it while splitting gets it back.
   */
  function deeper(id: string, title: string) {
    if (!asking) void change(`Go deeper on "${title}": split it into the smaller skills it needs, each its own topic with its prerequisites. Keep "${title}" as the first of them, with its id.`, { id, title });
  }

  /** Codemm changes the roadmap as it stands now, so the learner's own edits wait until it's done (an open one closes). */
  async function change(text: string, keep?: { id: string; title: string }) {
    setAsking(true);
    setEditing(undefined);
    setAdding(false);
    try {
      const result = await api.reviseRoadmap(concepts, text);
      const retitled = keep && result.roadmap.concepts.some((c) => c.id === keep.id && c.title !== keep.title);
      const next = retitled ? renameTopic(result.roadmap.concepts, keep.id, keep.title) : result.roadmap.concepts;
      if (retitled) await api.saveDraft(next);
      setConcepts(next);
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
      lessonCache(api).clear();
      cacheFor(api, 'conversations').clear();
      const now = (await api.course())?.topics.find((t) => t.state === 'now');
      go(now ? { to: 'topic', topicId: now.id } : { to: 'learn' });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <main className="main editor">
      <div className="editor-body">
        <div className="stack editor-col" style={{ gap: 10 }}>
          <h1 className="h2 a-up">{roadmap.title}</h1>
          {roadmap.goal !== roadmap.title && <p className="sub a-up">{roadmap.goal}</p>}
          {sources.length > 0 && (
            <section className="sources a-up" style={stagger(0, 100)} aria-labelledby="sources-t">
              <h2 id="sources-t">Sources</h2>
              <ul>
                {sources.map((s) => (
                  <li key={s.url}><ExternalLink href={s.url}>{s.title}</ExternalLink></li>
                ))}
              </ul>
            </section>
          )}
          <ol className="topics" aria-label="Roadmap">
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
                onDeeper={() => deeper(c.id, c.title)}
                onMove={(to) => edit((cs) => moveTopic(cs, c.id, to))}
                onDragStart={() => (dragFrom.current = c.id)}
                onDrop={() => dragFrom.current && edit((cs) => moveTopic(cs, dragFrom.current!, i))}
                locked={asking}
              />
            ))}
            {adding && <TopicItem index={concepts.length} count={concepts.length + 1} title="" editing onEdit={() => {}} onRename={add} />}
          </ol>
          <button className="add a-up" type="button" style={stagger(0, 100)} disabled={adding || asking} onClick={() => setAdding(true)}>
            <Icon name="plus" color="#0E2754" size={16} />
            Add a topic
          </button>
        </div>
      </div>
      {/* Its own space under the topics: asking, what Codemm said, and Approve are always in view, and nothing covers them. */}
      <footer className="editor-foot">
        <div className="stack editor-col" style={{ gap: 10 }}>
          {asking && job && <JobBar job={job} label="Changing the roadmap" />}
          <p className={asking ? 'quiet-text' : 'alert'} role="status">{asking ? (job ? '' : 'Updating the roadmap…') : notice}</p>
          <div className="editor-actions">
            <form className="composer" onSubmit={ask}>
              <Field aria-label="Ask Codemm for changes" placeholder="Ask Codemm for changes" value={request} maxLength={LIMITS.words} disabled={asking} onChange={(e) => setRequest(e.target.value)} />
              <Button type="submit" variant="ghost" size="lg" disabled={!request.trim() || asking}>Apply</Button>
            </form>
            {/* A typed request is applied or cleared first, so approving never drops it. */}
            <Button size="lg" disabled={concepts.length === 0 || editing !== undefined || adding || asking || request.trim() !== ''} onClick={approve}>Approve</Button>
          </div>
          <Limit value={request} max={LIMITS.words} />
        </div>
      </footer>
    </main>
  );
}
