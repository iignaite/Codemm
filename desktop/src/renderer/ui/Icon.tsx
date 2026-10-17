import type { ReactNode } from 'react';

const PATHS = {
  path: { w: 2.2, d: <><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 7.5v9M8.5 5.5c6 0 9.5 1.5 9.5 4" /></> },
  code: { w: 2.2, d: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /> },
  layers: { w: 2.2, d: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></> },
  check: { w: 3.4, d: <path d="M5 12.5l4.5 4.5L19 7.5" /> },
  x: { w: 3.4, d: <path d="M6 6l12 12M18 6L6 18" /> },
  lock: { w: 2.2, d: <><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></> },
  book: { w: 2.2, d: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></> },
  pencil: { w: 2.2, d: <path d="M4 20h4L19 9l-4-4L4 16z" /> },
  grip: { w: 2.4, d: <path d="M5 9h14M5 15h14" /> },
  plus: { w: 2.6, d: <path d="M12 5v14M5 12h14" /> },
  review: { w: 2.2, d: <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v4h4" /></> },
} satisfies Record<string, { w: number; d: ReactNode }>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, color = 'currentColor', size = 20 }: { name: IconName; color?: string; size?: number }) {
  const { w, d } = PATHS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d}
    </svg>
  );
}

export function Status({ kind, size = 26, label }: { kind: 'ok' | 'fail' | 'run'; size?: number; label?: string }) {
  const name = label ?? { ok: 'Passed', fail: 'Not yet', run: 'In progress' }[kind];
  return (
    <span className={`ico ${kind}`} style={{ width: size, height: size }} role="img" aria-label={name}>
      {kind === 'ok' && <Icon name="check" color="#fff" size={Math.round(size * 0.54)} />}
      {kind === 'fail' && <Icon name="x" color="#fff" size={Math.round(size * 0.46)} />}
    </span>
  );
}
