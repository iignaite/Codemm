import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Limit } from '../../ui/Limit';
import { LIMITS } from '../../../shared/limits';

export function NoteEditor({ note, onSave, onCancel }: { note: string; onSave: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(note);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(text.trim());
  }
  return (
    <form className="stack note-form" onSubmit={submit}>
      <textarea className="field" aria-label="My note" rows={3} value={text} maxLength={LIMITS.note} autoFocus onChange={(e) => setText(e.target.value)} />
      <Limit value={text} max={LIMITS.note} />
      <div className="actions">
        <Button type="submit">Save</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
