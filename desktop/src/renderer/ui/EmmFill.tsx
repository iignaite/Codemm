import type { CSSProperties } from 'react';
import { Emm } from './Emm';

/**
 * Emm as a progress fill (§4.11): a grey Emm, with a colored Emm clipped from the tail to the head as far as `value`
 * (0 to 1). Both are the same artwork, so the fill keeps Emm's exact shape. The fill edge shimmers while it runs;
 * full, Emm's eye opens. Decorative: the progressbar around it says what it means.
 */
export function EmmFill({ value, width, dim = false }: { value: number; width: number; dim?: boolean }) {
  const full = value >= 1;
  const fill = { '--fill': `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` } as CSSProperties;
  return (
    <span className={`emm-fill${dim ? ' dim' : ''}${full ? ' full' : ''}`} style={{ ...fill, width }} aria-hidden="true">
      <span className="emm-base"><Emm mood="sleep" width={width} /></span>
      <span className="emm-color"><Emm mood={full ? 'wake' : 'sleep'} width={width} /></span>
      {!full && <span className="emm-edge"><Emm mood="sleep" width={width} /></span>}
    </span>
  );
}
