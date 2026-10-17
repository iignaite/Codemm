import { useState, type FormEvent, type ReactNode } from 'react';
import type { Message } from '../../shared/api';
import { Button } from './Button';
import { Emm } from './Emm';
import { Field } from './Field';
import { Icon } from './Icon';

function Entry({ m }: { m: Message }) {
  if (m.from === 'you') return <p className="you a-up"><b>You:</b> {m.text}</p>;
  return (
    <div className={`note a-up${m.locked ? ' lock' : ''}`}>
      {m.locked && <Icon name="lock" color="#4A5B7A" size={16} />}
      {m.line !== undefined && <span className="ln" aria-label={`Line ${m.line}`}>{m.line}</span>}
      <span>{m.text}</span>
    </div>
  );
}

/** The Codemm tutor beside a lesson or activity. */
export function Rail({ messages, onAsk, name, children }: { messages: Message[]; onAsk: (text: string) => void; name?: string; children?: ReactNode }) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    onAsk(q);
    setText('');
  }
  return (
    <aside className="coach" aria-label="Codemm">
      <div className="chead"><Emm width={40} name={name} />Codemm</div>
      <div className="cbody" role="log">
        {messages.map((m, i) => <Entry key={i} m={m} />)}
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
