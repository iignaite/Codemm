import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Note } from '../../shared/api';
import { Button, Field } from './controls';
import { Emm } from './Emm';
import { Icon } from './Icon';
import type { PaletteName } from './palette';

function NoteView({ note }: { note: Note }) {
  if (note.from === 'you') return <p className="you a-up"><b>You:</b> {note.text}</p>;
  if (note.lock) return <div className="note lock a-up"><Icon name="lock" color="#4A5B7A" size={16} /><span>{note.text}</span></div>;
  return (
    <div className="note a-up">
      {note.line !== undefined && <span className="ln" role="img" aria-label={`Line ${note.line}`}>{note.line}</span>}
      <span>{note.text}</span>
    </div>
  );
}

/** The Codemm rail: a log of notes and a composer. Practice controls go in `children`. */
export function Rail({ notes, onAsk, palette = 'green', children }: {
  notes: Note[]; onAsk: (text: string) => void; palette?: PaletteName; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView?.({ block: 'end' });
  }, [notes]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onAsk(t);
    setText('');
  }

  return (
    <aside className="coach" aria-label="Codemm">
      <div className="chead"><Emm width={40} perch={false} palette={palette} />Codemm</div>
      <div className="cbody" role="log" ref={log}>
        {notes.map((n, i) => <NoteView key={i} note={n} />)}
      </div>
      <div className="cfoot">
        {children}
        <form className="composer" onSubmit={submit}>
          <Field aria-label="Ask Codemm" placeholder="Ask Codemm" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit">Send</Button>
        </form>
      </div>
    </aside>
  );
}
