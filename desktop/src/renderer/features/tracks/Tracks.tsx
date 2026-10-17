import { useState, type FormEvent } from 'react';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Shell';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Field } from '../../ui/Field';
import { stagger } from '../../ui/motion';

/** What Codemm has set up. Anything else is one request away. */
export function Tracks() {
  const api = useApi();
  const { go, fail } = useRouter();
  const { data, error, reload } = useLoad(async () => ({ tracks: await api.tracks(), suggestions: await api.suggestions() }), []);
  const [topic, setTopic] = useState('');
  const [rebuilding, setRebuilding] = useState<string>();
  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return null;

  async function rebuild(id: string) {
    setRebuilding(id);
    try {
      await api.rebuild(id);
    } catch (e) {
      fail(e);
    } finally {
      setRebuilding(undefined);
    }
  }

  function start(e: FormEvent) {
    e.preventDefault();
    if (topic.trim()) go({ to: 'research', goal: { topic: topic.trim(), known: [] } });
  }

  return (
    <main className="main page">
      <h1 className="h2 a-up">Tracks</h1>
      {data.tracks.length > 0 && (
        <ul className="track-grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {data.tracks.map((t, i) => (
            <li key={t.id} className="card track a-up" style={stagger(i + 1)} aria-label={t.name}>
              <Emm width={140} name={t.name} perch />
              <b>{t.name}</b>
              <Button variant="ghost" disabled={rebuilding === t.id} onClick={() => rebuild(t.id)}>Rebuild</Button>
            </li>
          ))}
        </ul>
      )}
      <section className="card new a-up" style={stagger(4)} aria-labelledby="new-t">
        <h2 className="h3" id="new-t">Learn something new</h2>
        <form className="composer" onSubmit={start}>
          <Field aria-labelledby="new-t" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Button type="submit" size="lg" disabled={!topic.trim()}>Start</Button>
        </form>
        <div className="chips">
          {data.suggestions.next.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setTopic(s)}>{s}</button>
          ))}
        </div>
      </section>
    </main>
  );
}
