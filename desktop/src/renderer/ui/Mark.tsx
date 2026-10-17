import { useId } from 'react';
import logo from '../../../../docs/brand/codemm-logo.svg';
import logoOnNavy from '../../../../docs/brand/codemm-logo-dark.svg';

/** The Codemm chevron alone. */
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

/** The brand logo (the wordmark is outlined, so it needs no font). */
export function Logo({ height, onNavy = false, className }: { height: number; onNavy?: boolean; className?: string }) {
  return <img className={className} src={onNavy ? logoOnNavy : logo} alt="Codemm" height={height} />;
}
