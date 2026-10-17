import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A button that opens a small keyboard menu. */
export function Menu({ label, button, items, className = 'ibtn', up = false }: {
  label: string; button: ReactNode; items: MenuItem[]; className?: string; up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const enabled = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => {
    if (open) enabled()[0]?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = enabled();
      const at = list.indexOf(document.activeElement as HTMLElement);
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  function onBlur(e: FocusEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  }

  return (
    <div className="menu-wrap" onBlur={onBlur}>
      <button ref={trigger} type="button" className={className} aria-label={label} aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && (
        <div ref={menu} id={id} role="menu" aria-label={label} className={`card menu a-pop ${up ? 'up' : ''}`} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className="btn text" tabIndex={-1} disabled={item.disabled}
              onClick={() => { close(); item.onSelect(); }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
