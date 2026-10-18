import type { CSSProperties, ReactNode } from 'react';

/** A quiet info card: what's true, and the one action it offers, spread to the far side. */
export function Banner({ children, action, art, style }: { children: ReactNode; action?: ReactNode; art?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`card info a-up${action ? ' resume' : ''}`} style={style}>
      {art}
      <span>{children}</span>
      {action}
    </div>
  );
}
