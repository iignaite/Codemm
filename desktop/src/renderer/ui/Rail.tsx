import { useState, type FormEvent, type ReactNode } from 'react';
import type { Message } from '../../shared/api';
import type { HeardJob } from '../app/useJob';
import { Button } from './Button';
import { Emm } from './Emm';
import { Field } from './Field';
import { JobBar } from './JobBar';
import { Markdown } from './Markdown';

function Entry({ m }: { m: Message }) {
  if (m.from === 'you') return <p className="you a-up"><b>You:</b> {m.text}</p>;
  return <div className="note a-up"><Markdown text={m.text} className="md small" /></div>;
}

/** The Codemm tutor beside a lesson or activity. While it answers, `answering` is that turn's progress (§4.11). */
export function Rail({ messages, onAsk, busy = false, answering, name, children }: {
  messages: Message[]; onAsk: (text: string) => void; busy?: boolean; answering?: HeardJob; name?: string; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q);
    setText('');
  }
  return (
    <aside className="coach" aria-label="Codemm">
      <div className="chead"><Emm width={40} name={name} />Codemm</div>
      <div className="cbody" role="log" aria-busy={busy}>
        {messages.map((m, i) => <Entry key={i} m={m} />)}
        {busy && (
          <div className="note thinking a-up">
            <span role="status">Codemm is thinking…</span>
            {answering && <JobBar job={answering} label="Codemm's answer" />}
          </div>
        )}
      </div>
      <div className="cfoot">
        {children}
        <form className="composer" onSubmit={submit}>
          <Field aria-label="Ask Codemm" placeholder="Ask Codemm" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" disabled={busy}>Send</Button>
        </form>
      </div>
    </aside>
  );
}
