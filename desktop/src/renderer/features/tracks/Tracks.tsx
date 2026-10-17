import { useId, useState, type FormEvent } from 'react';
import { useApi, useLive } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button, Chip, Field } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { stagger } from '../../ui/motion';
import { paletteFor } from '../../ui/palette';

/** What Codemm has set up. Anything else is one request away. */
export function Tracks() {
  const api = useApi();
  const { go } = useNav();
  const tracks = useLive((a) => a.listTracks(), []) ?? [];
  const suggestions = useLive((a) => a.suggestions(), []);
  const [topic, setTopic] = useState('');
  const [rebuilding, setRebuilding] = useState<string>();
  const titleId = useId();

  async function rebuild(id: string) {
    setRebuilding(id);
    await api.rebuildTrack(id).finally(() => setRebuilding(undefined));
  }

  function start(e: FormEvent) {
    e.preventDefault();
    if (topic.trim()) go({ to: 'research', goal: { topic: topic.trim(), known: [] } });
  }

  return (
    <main className="main" style={{ padding: '48px 56px', gap: 24 }}>
      <h1 className="h2 a-up">Tracks</h1>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, maxWidth: 1040 }}>
        {tracks.map((t, i) => (
          <li key={t.id} className="card a-up" style={{ ...stagger(i + 1), padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <Emm width={140} palette={paletteFor(t.name)} />
            <b style={{ font: '600 20px var(--display)' }}>{t.name}</b>
            <Button kind="ghost" aria-label={`Rebuild ${t.name}`} disabled={rebuilding === t.id} onClick={() => rebuild(t.id)}>Rebuild</Button>
          </li>
        ))}
      </ul>
      <section className="card a-up" style={{ ...stagger(4), padding: 24, maxWidth: 1040, display: 'flex', flexDirection: 'column', gap: 14 }} aria-labelledby={titleId}>
        <h2 className="h3" id={titleId}>Learn something new</h2>
        <form className="composer" onSubmit={start}>
          <Field aria-labelledby={titleId} value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Button type="submit" size="lg" disabled={!topic.trim()}>Start</Button>
        </form>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          {suggestions?.learn.map((s) => <Chip key={s} onClick={() => setTopic(s)}>{s}</Chip>)}
        </div>
      </section>
    </main>
  );
}
