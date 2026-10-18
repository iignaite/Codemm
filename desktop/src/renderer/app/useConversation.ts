import { useCallback, useRef, useState } from 'react';
import type { Message, Place } from '../../shared/api';
import { useApi } from './api';
import { useRouter } from './router';
import { useJob } from './useJob';

/**
 * The Codemm rail's conversation for one lesson or activity. One question at a
 * time: `busy` is true while Codemm answers, and asking does nothing until then; `answering` is its progress.
 * `before` runs first, so an activity can save the learner's latest code.
 */
export function useConversation(place: Place, opening: string) {
  const api = useApi();
  const { fail } = useRouter();
  const [messages, setMessages] = useState<Message[]>([{ from: 'codemm', text: opening }]);
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  // The tutor turn's progress while Codemm answers (§4.11).
  const answering = useJob((p) => p.kind === 'tutor', []);
  const add = useCallback((...m: Message[]) => setMessages((ms) => [...ms, ...m]), []);
  async function ask(text: string, before?: () => Promise<void>) {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    add({ from: 'you', text });
    try {
      await before?.();
      add(...(await api.ask(place, text)));
    } catch (e) {
      fail(e);
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }
  return { messages, add, ask, busy, answering: busy ? answering : undefined };
}
