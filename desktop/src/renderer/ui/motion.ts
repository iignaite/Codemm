import type { CSSProperties } from 'react';

/** Stagger for `.a-up` and `.a-pop`: item `i`, after `d` milliseconds. */
export function stagger(i = 0, d = 0): CSSProperties {
  return { '--i': i, '--d': `${d}ms` } as CSSProperties;
}
