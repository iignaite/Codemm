import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';

export function NoteEditor({ note, onSave, onCancel }: { note: string; onSave: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(note);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(text.trim());
  }
  return (
    <form className="stack" style={{ maxWidth: 600 }} onSubmit={submit}>
      <textarea className="field" aria-label="My note" rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
      <div className="actions">
        <Button type="submit">Save</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
