import { useId } from 'react';

/** The Codemm chevron. With "odemm" after it, it reads "Codemm". */
export function Mark({ size = 24 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 600 600" aria-hidden="true">
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

export function Logo({ size = 24, className = 'logo' }: { size?: number; className?: string }) {
  return (
    <div className={className} role="img" aria-label="Codemm">
      <Mark size={size} />
      <span aria-hidden="true">odemm</span>
    </div>
  );
}
