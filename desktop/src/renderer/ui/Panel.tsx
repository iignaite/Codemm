import type { ReactNode } from 'react';

/** A centered card that says what stopped, with Emm, a heading, a line of help and the ways forward. */
export function Panel({ art, title, level = 1, text, children }: { art: ReactNode; title: string; level?: 1 | 2; text?: string; children: ReactNode }) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="card panel a-pop" role="alert">
      {art}
      <Heading className="h2">{title}</Heading>
      {text && <p className="sub">{text}</p>}
      <div className="actions">{children}</div>
    </div>
  );
}
