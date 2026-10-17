import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { stagger } from '../../ui/motion';

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
}

/** One topic in the course editor. Dragging works, and so does the Move menu. */
export function TopicItem({ index, count, title, editing, onEdit, onRename, onRemove, onDeeper, onMove, onDragStart, onDrop }: Props) {
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
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <button ref={grip} className="ibtn" type="button" aria-label={`Move ${title}`} aria-haspopup="menu" aria-expanded={menu} disabled={count < 2 || !onMove} onClick={() => setMenu(!menu)}>
        <Icon name="grip" color="#8492A9" size={17} />
      </button>
      <span className="num" aria-hidden="true">{index + 1}</span>
      {editing ? (
        <form style={{ flex: 1, display: 'flex', gap: 8 }} onSubmit={commit}>
          <input className="name" aria-label="Topic name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button variant="text" type="submit">Done</Button>
        </form>
      ) : (
        <>
          <span className="name">{title}</span>
          {onDeeper && (
            <button className="ibtn" type="button" aria-label={`Go deeper on ${title}`} title="Go deeper" onClick={onDeeper}>
              <Icon name="layers" color="#5B6A84" size={17} />
            </button>
          )}
          <button className="ibtn" type="button" aria-label={`Rename ${title}`} onClick={onEdit}>
            <Icon name="pencil" color="#5B6A84" size={17} />
          </button>
          <button className="ibtn" type="button" aria-label={`Remove ${title}`} onClick={onRemove}>
            <Icon name="x" color="#5B6A84" size={13} />
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
