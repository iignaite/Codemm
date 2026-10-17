import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
const focusables = (el: HTMLElement | null) => (el ? [...el.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);

/** A modal dialog: focus moves in, stays in, and returns on close. Escape closes. */
export function Dialog({ title, art, children, onClose }: {
  title: string; art?: ReactNode; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    focusables(ref.current)[0]?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(ref.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="scrim">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        {art}
        <h2 className="h2" id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
