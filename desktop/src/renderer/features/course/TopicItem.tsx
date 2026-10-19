import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';
import { Limit } from '../../ui/Limit';
import { LIMITS } from '../../../shared/limits';

interface Props {
  index: number;
  count: number;
  title: string;
  editing: boolean;
  onEdit: () => void;
  onRename: (title: string) => void;
  onRemove?: () => void;
  /** Asks Codemm to split this topic into the smaller skills it needs. */
  onDeeper?: () => void;
  onMove?: (to: number) => void;
  onDragStart?: () => void;
  onDrop?: () => void;
  /** Codemm is changing the roadmap: nothing can be edited until it's done. */
  locked?: boolean;
}

/** One topic in the course editor. Dragging works, and so does the Move menu. */
export function TopicItem({ index, count, title, editing, onEdit, onRename, onRemove, onDeeper, onMove, onDragStart, onDrop, locked = false }: Props) {
  const [name, setName] = useState(title);
  const [menu, setMenu] = useState(false);
  const grip = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moves = [
    index > 0 && { label: 'Move up', to: index - 1 },
    index < count - 1 && { label: 'Move down', to: index + 1 },
  ].filter((m) => m !== false);

  useEffect(() => {
    if (editing) setName(title);
  }, [editing, title]);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector('button')?.focus();
  }, [menu]);

  function closeMenu() {
    setMenu(false);
    grip.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent) {
    const buttons = [...(menuRef.current?.querySelectorAll('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  }

  function commit(e: FormEvent) {
    e.preventDefault();
    onRename(name.trim());
  }

  return (
    <li
      className={`card topic a-up${editing ? ' on' : ''}`}
      style={stagger(index, 100)}
      aria-label={title}
      draggable={!editing && !locked}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <button ref={grip} className="ibtn" type="button" aria-label={`Move ${title}`} title="Move" aria-haspopup="menu" aria-expanded={menu} disabled={count < 2 || !onMove || locked} onClick={() => setMenu(!menu)}>
        <Icon name="grip" color="var(--ctl)" size={17} />
      </button>
      <span className="num" aria-hidden="true">{index + 1}</span>
      {editing ? (
        <form className="rename" onSubmit={commit}>
          <input className="name" aria-label="Topic name" value={name} maxLength={LIMITS.title} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button variant="text" type="submit">Done</Button>
          <Limit value={name} max={LIMITS.title} />
        </form>
      ) : (
        <>
          <span className="name">{title}</span>
          {onDeeper && (
            <button className="deeper" type="button" aria-label={`Go deeper on ${title}`} disabled={locked} onClick={onDeeper}>
              <Icon name="layers" color="var(--faint)" size={16} />
              Go deeper
            </button>
          )}
          <button className="ibtn" type="button" aria-label={`Rename ${title}`} title="Rename" disabled={locked} onClick={onEdit}>
            <Icon name="pencil" color="var(--faint)" size={17} />
          </button>
          <button className="ibtn" type="button" aria-label={`Remove ${title}`} title="Remove" disabled={locked} onClick={onRemove}>
            <Icon name="x" color="var(--faint)" size={13} />
          </button>
        </>
      )}
      {menu && (
        <div ref={menuRef} className="card menu a-pop" role="menu" aria-label={`Move ${title}`} onKeyDown={onMenuKey}>
          {moves.map((m) => (
            <Button key={m.label} variant="text" role="menuitem" onClick={() => { closeMenu(); onMove?.(m.to); }}>{m.label}</Button>
          ))}
        </div>
      )}
    </li>
  );
}
