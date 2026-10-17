import type { CSSProperties } from 'react';

/** Stagger for .a-up and .a-pop: item index and extra delay in ms. */
export const stagger = (i: number, d = 0): CSSProperties => ({ '--i': i, '--d': `${d}ms` }) as CSSProperties;
