import { useState, type FormEvent } from 'react';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Field } from '../../ui/Field';
import { stagger } from '../../ui/motion';

/** Any language or framework. Codemm asks what the learner already knows. */
export function Goal() {
  const { go } = useRouter();
  const api = useApi();
  const { data: tracks } = useLoad(() => api.tracks(), []);
  const [topic, setTopic] = useState('');
  const [known, setKnown] = useState('');
  const goal = topic.trim();
  const isNew = goal !== '' && tracks !== undefined && !tracks.some((t) => t.name.toLowerCase() === goal.toLowerCase());

  function start(e: FormEvent) {
    e.preventDefault();
    if (goal) go({ to: 'research', goal: { topic: goal, known: known.trim() } });
  }

  return (
    <main className="center">
      <form className="stack" style={{ width: 680, gap: 22 }} onSubmit={start}>
        <h1 className="h1 a-up" id="goal-q">What do you want to learn?</h1>
        <div className="goal-box a-up" style={stagger(1)}>
          <input aria-labelledby="goal-q" value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
          <Button type="submit" disabled={!goal}>Start</Button>
        </div>
        <Field className="a-up" style={stagger(2)} aria-label="I already know" placeholder="I already know" value={known} onChange={(e) => setKnown(e.target.value)} />
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
