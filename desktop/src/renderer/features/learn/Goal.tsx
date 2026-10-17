import { useId, useState, type FormEvent } from 'react';
import { useLive } from '../../app/api';
import { useNav } from '../../app/nav';
import { Button, Chip } from '../../ui/controls';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** Any language or framework. Codemm asks what the learner already knows. */
export function Goal() {
  const { go } = useNav();
  const tracks = useLive((api) => api.listTracks(), []);
  const suggestions = useLive((api) => api.suggestions(), []);
  const [topic, setTopic] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const [nothing, setNothing] = useState(false);
  const titleId = useId();
  const wanted = topic.trim();
  const missing = wanted && tracks && !tracks.some((t) => t.name.toLowerCase() === wanted.toLowerCase());

  function toggle(k: string) {
    setNothing(false);
    setKnown((list) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (wanted) go({ to: 'research', goal: { topic: wanted, known } });
  }

  return (
    <main className="center">
      <form onSubmit={submit} style={{ width: 680, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <h1 className="h1 a-up" id={titleId}>What do you want to learn?</h1>
        <div className="ask a-up" style={stagger(1)}>
          <input aria-labelledby={titleId} value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
          <Button type="submit" disabled={!wanted}>Start</Button>
        </div>
        <div className="a-up" style={{ ...stagger(2), display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} role="group" aria-label="I already know">
          <span aria-hidden="true" style={{ fontSize: 15, fontWeight: 600, marginRight: 4 }}>I know</span>
          {suggestions?.known.map((k) => (
            <Chip key={k} pressed={known.includes(k)} onClick={() => toggle(k)}>
              {known.includes(k) && <Icon name="check" color="#0E7C35" size={13} />}{k}
            </Chip>
          ))}
          <Chip pressed={nothing} onClick={() => { setKnown([]); setNothing(!nothing); }}>
            {nothing && <Icon name="check" color="#0E7C35" size={13} />}Nothing yet
          </Chip>
        </div>
        {missing && (
          <div className="card notice a-up" style={stagger(3)}>
            <Emm mood="look" width={56} perch={false} />
            <span><b>{`${wanted} isn't set up yet.`}</b> Codemm will set it up.</span>
          </div>
        )}
      </form>
    </main>
  );
}
