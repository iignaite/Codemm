import { useId } from 'react';

const PATHS = {
  path: <><circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 7.5v9M8.5 5.5c6 0 9.5 1.5 9.5 4" /></>,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  down: <path d="M6 9l6 6 6-6" />,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></>,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  grip: <path d="M5 9h14M5 15h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  review: <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v4h4" /></>,
};

const WEIGHT: Partial<Record<keyof typeof PATHS, number>> = { check: 3.4, x: 3.4, down: 2.6, grip: 2.4, plus: 2.6 };

export type IconName = keyof typeof PATHS;

export function Icon({ name, color = 'currentColor', size = 20 }: { name: IconName; color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={WEIGHT[name] ?? 2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The Codemm chevron. */
export function Mark({ size = 24 }: { size?: number }) {
  const id = 'mark' + useId().replace(/[^\w-]/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 600 600" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3DDB6C" />
          <stop offset="1" stopColor="#17B04B" />
        </linearGradient>
      </defs>
      <polyline points="520,60 80,300 520,540" fill="none" stroke={`url(#${id})`} strokeWidth="124" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return <div className="logo"><Mark size={size} /><span aria-hidden="true">odemm</span><span className="sr">Codemm</span></div>;
}

type Status = 'ok' | 'fail' | 'run';
const STATUS_LABEL: Record<Status, string> = { ok: 'Passed', fail: 'Not yet', run: 'In progress' };

export function StatusIcon({ status, size = 26, label = STATUS_LABEL[status] }: { status: Status; size?: number; label?: string }) {
  return (
    <span className={`ico ${status}`} style={{ width: size, height: size }} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      {status === 'ok' && <Icon name="check" color="#fff" size={Math.round(size * 0.54)} />}
      {status === 'fail' && <Icon name="x" color="#fff" size={Math.round(size * 0.46)} />}
    </span>
  );
}
