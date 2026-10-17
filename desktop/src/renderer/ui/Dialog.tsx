import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A modal dialog: the rest of the window goes inert, focus moves in and stays in, Escape closes, focus goes back. */
type Props = { title: string; text?: string; art?: ReactNode; body?: ReactNode; onClose: () => void; children: ReactNode };

export function Dialog({ title, text, art, body, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const others = [...document.body.children].filter((el) => !el.contains(ref.current));
    others.forEach((el) => el.setAttribute('inert', ''));
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      others.forEach((el) => el.removeAttribute('inert'));
      back?.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
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

  return createPortal(
    <div className="scrim">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        {art}
        <h2 className="h2" id={titleId}>{title}</h2>
        {text && <p className="sub">{text}</p>}
        {body}
        <div className="actions">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
