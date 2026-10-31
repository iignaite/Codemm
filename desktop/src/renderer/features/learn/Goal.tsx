import { useEffect, useState, type FormEvent } from 'react';
import type { Depth, Practice } from '../../../shared/api';
import { useApi } from '../../app/api';
import { useRouter } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Button } from '../../ui/Button';
import { Emm } from '../../ui/Emm';
import { Field } from '../../ui/Field';
import { stagger } from '../../ui/motion';
import { Banner } from '../../ui/Banner';
import { Limit } from '../../ui/Limit';
import { LIMITS } from '../../../shared/limits';
import { shownTopic } from '../../../shared/topic';

/** How long typing pauses before the goal counts as settled, so the notice never names half a word. */
const SETTLE_MS = 600;

const DEPTHS: [Depth, string][] = [
  ['overview', 'Overview'],
  ['standard', 'Standard'],
  ['in-depth', 'In depth'],
];

/** Any language or framework. Codemm asks what the learner already knows, and how deep to go. */
export function Goal() {
  const { go } = useRouter();
  const api = useApi();
  const { data: tracks } = useLoad(() => api.tracks(), []);
  // A roadmap not approved yet: the learner left it, or Codemm was closed (§4.2).
  const { data: draft } = useLoad(() => api.draft(), []);
  const [topic, setTopic] = useState('');
  const [known, setKnown] = useState('');
  const [depth, setDepth] = useState<Depth>('standard');
  const [practice, setPractice] = useState<Practice>('code');
  const goal = topic.trim();
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(goal), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [goal]);
  const shown = shownTopic(goal);
  const isNew = goal !== '' && goal === settled && tracks !== undefined && !tracks.some((t) => t.name.toLowerCase() === shown.toLowerCase());

  function start(e: FormEvent) {
    e.preventDefault();
    if (goal) go({ to: 'research', goal: { topic: goal, known: known.trim(), depth, practice } });
  }

  return (
    <main className="center">
      <form className="stack wide goal-form" onSubmit={start}>
        <h1 className="h1 a-up" id="goal-q">What do you want to learn?</h1>
        <div className="goal-box a-up" style={stagger(1)}>
          <input aria-labelledby="goal-q" value={topic} maxLength={LIMITS.topic} onChange={(e) => setTopic(e.target.value)} autoFocus />
          <Button type="submit" disabled={!goal}>Start</Button>
        </div>
        <Limit value={topic} max={LIMITS.topic} />
        <Field className="a-up" style={stagger(2)} aria-label="What you already know (optional)" placeholder="What you already know (optional)" value={known} maxLength={LIMITS.known} onChange={(e) => setKnown(e.target.value)} />
        <Limit value={known} max={LIMITS.known} />
        <div className="depth a-up" style={stagger(3)} role="radiogroup" aria-labelledby="depth-q">
          <span className="depth-q" id="depth-q">How deep</span>
          {DEPTHS.map(([id, label]) => (
            <label key={id} className={`opt${depth === id ? ' on' : ''}`}>
              <input type="radio" name="depth" value={id} checked={depth === id} onChange={() => setDepth(id)} />
              {label}
            </label>
          ))}
        </div>
        <div className="depth a-up" style={stagger(4)} role="radiogroup" aria-labelledby="practice-q">
          <span className="depth-q" id="practice-q">How to practise</span>
          {([['code', 'Code'], ['none', 'Lessons only']] as const).map(([id, label]) => (
            <label key={id} className={`opt${practice === id ? ' on' : ''}`}>
              <input type="radio" name="practice" value={id} checked={practice === id} onChange={() => setPractice(id)} />
              {label}
            </label>
          ))}
        </div>
        {draft && (
          <Banner style={stagger(4)} action={<Button variant="ghost" onClick={() => go({ to: 'course', roadmap: draft })}>Resume roadmap</Button>}>
            <b>{draft.title}</b>
          </Banner>
        )}
        {isNew && practice === 'code' && (
          <Banner art={<Emm mood="look" width={56} />}><b>{shown} isn't set up yet.</b> Codemm will set it up.</Banner>
        )}
      </form>
    </main>
  );
}
