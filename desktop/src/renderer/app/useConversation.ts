import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, Place } from '../../shared/api';
import { useApi } from './api';
import { cacheFor } from './cache';
import { useRouter } from './router';

/**
 * The Codemm rail's conversation for one lesson or activity, kept per place while Codemm runs, so leaving and
 * coming back keeps it. One question at a time: `busy` is true while Codemm answers, and asking does nothing
 * until then. `before` runs first, so an activity can save the learner's latest code. `ask` resolves false when
 * the question failed: it is taken back, for the learner to send again.
 */
export function useConversation(place: Place, opening: string) {
  const api = useApi();
  const { fail } = useRouter();
  const saved = cacheFor<Message[]>(api, 'conversations');
  const key = 'lessonId' in place ? `lesson:${place.lessonId}` : `activity:${place.activityId}`;
  const [messages, setMessages] = useState<Message[]>(() => saved.get(key) ?? [{ from: 'codemm', text: opening }]);
  useEffect(() => saved.set(key, messages, saved.version()), [messages]);
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  const add = useCallback((...m: Message[]) => setMessages((ms) => [...ms, ...m]), []);
  async function ask(text: string, before?: () => Promise<void>): Promise<boolean> {
    if (asking.current) return false;
    asking.current = true;
    setBusy(true);
    const question: Message = { from: 'you', text };
    add(question);
    try {
      await before?.();
      add(...(await api.ask(place, text)));
      return true;
    } catch (e) {
      setMessages((ms) => ms.filter((m) => m !== question));
      fail(e);
      return false;
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }
  return { messages, add, ask, busy };
}
