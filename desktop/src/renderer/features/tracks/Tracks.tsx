import { useState, type FormEvent } from 'react';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { Failed } from '../../app/Problems';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Field } from '../../ui/Field';
import { stagger } from '../../ui/motion';
import { Limit } from '../../ui/Limit';
import { LIMITS } from '../../../shared/limits';

/** What Codemm has set up. Anything else is one request away. */
export function Tracks() {
  const api = useApi();
  const { go, fail } = useRouter();
  const { data: tracks, error, reload } = useLoad(() => api.tracks(), []);
  const [topic, setTopic] = useState('');
  const [rebuilding, setRebuilding] = useState<string>();
  const [rebuilt, setRebuilt] = useState<string>();
  if (error) return <Failed error={error} retry={reload} />;
  if (!tracks) return null;

  async function rebuild(ref: string) {
    setRebuilding(ref);
    setRebuilt(undefined);
    try {
      await api.rebuild(ref);
      setRebuilt(ref);
    } catch (e) {
      fail(e);
    } finally {
      setRebuilding(undefined);
    }
  }

  function start(e: FormEvent) {
    e.preventDefault();
    if (topic.trim()) go({ to: 'research', goal: { topic: topic.trim(), known: '', depth: 'standard' } });
  }

  return (
    <main className="main page">
      <h1 className="h2 a-up">Tracks</h1>
      {tracks.length > 0 && (
        <ul className="track-grid plain">
          {tracks.map((t, i) => (
            <li key={t.ref} className="card track a-up" style={stagger(i + 1)} aria-label={t.name}>
              <Emm width={140} name={t.name} perch />
              <b>{t.name}</b>
              <Button variant="ghost" disabled={rebuilding === t.ref} onClick={() => rebuild(t.ref)}>Rebuild</Button>
              <span className="quiet-text" role="status">{rebuilt === t.ref ? 'Rebuilt.' : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <section className="card new a-up" style={stagger(4)} aria-labelledby="new-t">
        <h2 className="h3" id="new-t">Learn something new</h2>
        <form className="composer" onSubmit={start}>
          <Field aria-labelledby="new-t" value={topic} maxLength={LIMITS.topic} onChange={(e) => setTopic(e.target.value)} />
          <Button type="submit" size="lg" disabled={!topic.trim()}>Start</Button>
        </form>
        <Limit value={topic} max={LIMITS.topic} />
      </section>
    </main>
  );
}
