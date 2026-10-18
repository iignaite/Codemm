import type { CSSProperties, ReactNode } from 'react';
import { Status } from './Icon';

/** Something Codemm is doing now: the running status beside its words. */
export function Busy({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`busy ${className}`.trim()} style={style}><Status kind="run" size={18} />{children}</div>;
}
