import { useState, type FormEvent } from 'react';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

const NOTHING = 'Nothing yet';

/** Any language or framework. Codemm asks what the learner already knows. */
export function Goal() {
  const api = useApi();
  const { go } = useRouter();
  const { data } = useLoad(async () => ({ suggestions: await api.suggestions(), tracks: await api.tracks() }), []);
  const [topic, setTopic] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const goal = topic.trim();
  const isNew = goal !== '' && data !== undefined && !data.tracks.some((t) => t.name.toLowerCase() === goal.toLowerCase());

  function toggle(option: string) {
    if (option === NOTHING) return setKnown([]);
    setKnown((k) => (k.includes(option) ? k.filter((o) => o !== option) : [...k, option]));
  }

  function start(e: FormEvent) {
    e.preventDefault();
    if (goal) go({ to: 'research', goal: { topic: goal, known } });
  }

  return (
    <main className="center">
      <form className="stack" style={{ width: 680, gap: 22 }} onSubmit={start}>
        <h1 className="h1 a-up" id="goal-q">What do you want to learn?</h1>
        <div className="goal-box a-up" style={stagger(1)}>
          <input aria-labelledby="goal-q" value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
          <Button type="submit" disabled={!goal}>Start</Button>
        </div>
        {data && (
          <div className="chips a-up" style={stagger(2)} role="group" aria-label="I already know">
            <span style={{ fontSize: 15, fontWeight: 600, marginRight: 4 }} aria-hidden="true">I know</span>
            {[...data.suggestions.known, NOTHING].map((option) => {
              const on = option === NOTHING ? known.length === 0 : known.includes(option);
              return (
                <button key={option} type="button" className="chip" aria-pressed={on} onClick={() => toggle(option)}>
                  {on && <Icon name="check" color="#0E7C35" size={13} />}
                  {option}
                </button>
              );
            })}
          </div>
        )}
        {isNew && (
          <div className="card info a-up">
            <Emm mood="look" width={56} />
            <span><b>{goal} isn't set up yet.</b> Codemm will set it up.</span>
          </div>
        )}
      </form>
    </main>
  );
}
