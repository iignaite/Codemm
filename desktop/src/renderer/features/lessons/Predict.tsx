import { useState } from 'react';
import type { Predict as PredictData } from '../../../shared/api';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

/** Guess first; then see what actually happens. */
export function Predict({ predict }: { predict: PredictData }) {
  const [chosen, setChosen] = useState<string>();
  return (
    <section className="card predict a-up" style={stagger(4)} aria-labelledby="predict-q">
      <b id="predict-q">{predict.question}</b>
      <div className="chips" role="group" aria-label="Your answer">
        {predict.choices.map((c) => (
          <button key={c} type="button" className="chip" aria-pressed={chosen === c} onClick={() => setChosen(c)}>
            {chosen === c && <Icon name="check" color="#0E7C35" size={13} />}
            {c}
          </button>
        ))}
      </div>
      <div aria-live="polite">{chosen && <div className="shows a-up">{predict.shows}</div>}</div>
    </section>
  );
}
