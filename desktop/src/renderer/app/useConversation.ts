import { useState } from 'react';
import type { Message, Place } from '../../shared/api';
import { useApi } from './api';
import { useRouter } from './router';

/** The Codemm rail's conversation for one lesson or activity. */
export function useConversation(place: Place, opening: string) {
  const api = useApi();
  const { fail } = useRouter();
  const [messages, setMessages] = useState<Message[]>([{ from: 'codemm', text: opening }]);
  const add = (...m: Message[]) => setMessages((ms) => [...ms, ...m]);
  async function ask(text: string) {
    add({ from: 'you', text });
    try {
      add(...(await api.ask(place, text)));
    } catch (e) {
      fail(e);
    }
  }
  return { messages, add, ask };
}
