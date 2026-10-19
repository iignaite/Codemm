import { useEffect, useReducer } from 'react';
import type { Drawn } from './drawDiagram';

/** A diagram's drawing, or null when it can't be drawn. Kept so a lesson reopens at once (§4.3), and drawn once. */
interface Drawing {
  value?: Drawn | null;
  done: Promise<unknown>;
}
const drawings = new Map<string, Drawing>();
const KEPT = 50;

function drawing(source: string): Drawing {
  let d = drawings.get(source);
  if (!d) {
    if (drawings.size >= KEPT) drawings.delete(drawings.keys().next().value!);
    const fresh: Drawing = { done: Promise.resolve() };
    // The drawing code, and mermaid with it, loads here and only here.
    fresh.done = import('./drawDiagram').then((m) => m.drawDiagram(source)).then((v) => (fresh.value = v), () => (fresh.value = null));
    drawings.set(source, (d = fresh));
  }
  return d;
}

/**
 * A diagram from a lesson's mermaid fence, drawn as an image with a text alternative. When it can't be drawn, its
 * source is shown as code with a short note, and the rest of the lesson reads as usual.
 */
export function Diagram({ source }: { source: string }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const d = drawing(source);
  useEffect(() => {
    let live = true;
    void d.done.then(() => live && redraw());
    return () => {
      live = false;
    };
  }, [d]);
  if (d.value === undefined) return <figure className="diagram wait" aria-busy="true" />;
  if (d.value === null) {
    return (
      <div className="diagram failed">
        <p>This diagram didn&apos;t draw. Here is its source.</p>
        <div className="md"><pre><code>{source}</code></pre></div>
      </div>
    );
  }
  return (
    <figure className="diagram">
      <img src={d.value.src} alt={d.value.alt} />
    </figure>
  );
}
